/-
Copyright (c) 2026 Timaeus. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
-/
import Lean

namespace DocGen4.Process

open Lean

/--
timaeus fork: an anonymous `example` declaration, captured verbatim from a module's
source file by a parser-only pass.

`example`s are elaborated inside `withoutModifyingEnv`, so they never reach the
`Environment` (or the olean) and are invisible to the constant-based analysis in
`DocGen4.Process.process`. Instead we re-run Lean's *parser* (no elaboration) over the
module source and collect the `example` commands, so they can be rendered on the module
page interleaved with the other members in source order.
-/
structure ExampleDecl where
  /--
  The verbatim source text of the `example` command (including any modifiers).
  -/
  source : String
  /--
  Where the example occurs in the module's source file.
  -/
  declarationRange : DeclarationRange
  deriving Inhabited

/--
Strips `open … in` / `set_option … in` style wrappers (`Command.in` nodes) so the
wrapped command can be inspected.
-/
private partial def unwrapCommandIn (stx : Syntax) : Syntax :=
  if stx.isOfKind ``Parser.Command.in then unwrapCommandIn stx[2] else stx

private def isExampleCommand (stx : Syntax) : Bool :=
  let stx := unwrapCommandIn stx
  stx.isOfKind ``Parser.Command.declaration && stx[1].getKind == ``Parser.Command.example

private def toDeclarationRange (fileMap : FileMap) (range : Syntax.Range) : DeclarationRange := {
  pos := fileMap.toPosition range.start
  charUtf16 := fileMap.utf8PosToLspPos range.start |>.character
  endPos := fileMap.toPosition range.stop
  endCharUtf16 := fileMap.utf8PosToLspPos range.stop |>.character
}

/--
Parse `contents` (the source of a module) and collect all `example` commands.

This runs only the parser, driven the same way as the compiler frontend but without any
elaboration, so it is cheap. The environment provides the parser/token tables, which
already include any custom syntax the module or its imports declare because the module
itself is loaded when this runs. Commands that fail to parse are skipped (the parser
recovers and continues with the next command).
-/
def extractExamplesFromSource (env : Environment) (fileName : String) (contents : String) :
    IO (Array ExampleDecl) := do
  -- Normalize up front: `mkInputContext` parses a crlf-normalized copy, so parser
  -- positions would not be valid offsets into a non-normalized `contents`.
  let contents := contents.crlfToLf
  let inputCtx := Parser.mkInputContext contents fileName
  let (_, parserState, msgs) ← Parser.parseHeader inputCtx
  let pmctx : Parser.ParserModuleContext := { env, options := {} }
  let mut state := parserState
  let mut msgs := msgs
  let mut examples := #[]
  repeat
    let (stx, state', msgs') := Parser.parseCommand inputCtx pmctx state msgs
    state := state'
    msgs := msgs'
    if Parser.isTerminalCommand stx then
      break
    if isExampleCommand stx then
      -- The range of the outer command, so `open … in` wrappers are part of the shown source.
      if let some range := stx.getRange? then
        let source := Substring.Raw.toString ⟨contents, range.start, range.stop⟩
        examples := examples.push { source, declarationRange := toDeclarationRange inputCtx.fileMap range }
  return examples

/--
Collect the `example` declarations of `module` by parsing its source file, found via the
`LEAN_SRC_PATH` search path (set by Lake). Returns `#[]` when the source file cannot be
located or read, so missing sources degrade to "no examples" instead of failing the build.
-/
def extractExamples (env : Environment) (module : Name) : IO (Array ExampleDecl) := do
  let fileName? ← try
    let path ← findLean (← getSrcSearchPath) module
    if ← path.pathExists then pure (some path) else pure none
  catch _ =>
    pure none
  let some fileName := fileName? | return #[]
  try
    extractExamplesFromSource env fileName.toString (← IO.FS.readFile fileName)
  catch e =>
    IO.println s!"WARNING: Failed to extract examples from {fileName}: {e}"
    return #[]

end DocGen4.Process
