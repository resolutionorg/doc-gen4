/-
Copyright (c) 2026 Timaeus. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
-/
import Lean
import DocGen4.Process.NameInfo

namespace DocGen4.Process

open Lean

/--
timaeus fork: an anonymous `example` declaration, recovered from a module's source file
by a parser pass and re-elaborated so it renders like any other declaration.

`example`s are elaborated inside `withoutModifyingEnv`, so they never reach the
`Environment` (or the olean) and are invisible to the constant-based analysis in
`DocGen4.Process.process`. Instead we re-run Lean's parser over the module source to
find the `example` commands, then re-elaborate each one's *signature* (binders + type,
never the body) in the already-loaded environment and pretty-print it through the same
path as declaration signatures, so the HTML gets the same hyperlinked markup.
-/
structure ExampleDecl where
  /--
  Rendered binders, like `Info.args`. Empty when `type` is `none`.
  -/
  args : Array Arg := #[]
  /--
  The rendered result type. `none` when signature elaboration failed (e.g. the example
  depends on section `variable`s or has no type ascription); the raw `signature` text is
  shown instead.
  -/
  type : Option RenderedCode := none
  /--
  The verbatim source text of the signature (everything before the body), used as the
  fallback display when `type` is `none`.
  -/
  signature : String
  /--
  Where the example occurs in the module's source file.
  -/
  declarationRange : DeclarationRange
  deriving Inhabited

/--
An `example` command as located by the parser pass, together with the scope information
needed to re-elaborate its signature.
-/
private structure RawExample where
  /-- The `Parser.Command.declaration` node (with any `… in` wrappers stripped). -/
  decl : Syntax
  /-- `openDecl` syntaxes in force: file-level `open`s plus any `open … in` wrappers. -/
  opens : Array Syntax
  /-- The namespace the example occurs in, tracked from `namespace`/`end` commands. -/
  currNamespace : Name
  signature : String
  declarationRange : DeclarationRange

/--
A `namespace`/`section` scope tracked during the parse pass. Mirrors Lean's own scoping:
`namespace A.B` pushes one scope per component, `end A.B` pops one per component.
-/
private structure ParseScope where
  isNamespace : Bool
  /-- Number of `open` declarations in force when the scope was entered. -/
  opensLen : Nat

/--
Strips `open … in` / `set_option … in` style wrappers (`Command.in` nodes), collecting
the `openDecl`s of any `open … in` wrappers along the way.
-/
private partial def unwrapCommandIn (stx : Syntax) (opens : Array Syntax := #[]) :
    Syntax × Array Syntax :=
  if stx.isOfKind ``Parser.Command.in then
    let opens :=
      if stx[0].isOfKind ``Parser.Command.open then opens.push stx[0][1] else opens
    unwrapCommandIn stx[2] opens
  else
    (stx, opens)

private def isExampleCommand (stx : Syntax) : Bool :=
  stx.isOfKind ``Parser.Command.declaration && stx[1].getKind == ``Parser.Command.example

private def toDeclarationRange (fileMap : FileMap) (range : Syntax.Range) : DeclarationRange := {
  pos := fileMap.toPosition range.start
  charUtf16 := fileMap.utf8PosToLspPos range.start |>.character
  endPos := fileMap.toPosition range.stop
  endCharUtf16 := fileMap.utf8PosToLspPos range.stop |>.character
}

/--
Parse `contents` (the source of a module) and locate all `example` commands, tracking
`namespace`/`section`/`end`/`open` commands along the way so each example carries the
scope it occurs in.

This runs only the parser, driven the same way as the compiler frontend but without any
elaboration, so it is cheap. The environment provides the parser/token tables, which
already include any custom syntax the module or its imports declare because the module
itself is loaded when this runs. Commands that fail to parse are skipped (the parser
recovers and continues with the next command).
-/
private def parseExampleCommands (env : Environment) (fileName : String) (contents : String) :
    IO (Array RawExample) := do
  -- Normalize up front: `mkInputContext` parses a crlf-normalized copy, so parser
  -- positions would not be valid offsets into a non-normalized `contents`.
  let contents := contents.crlfToLf
  let inputCtx := Parser.mkInputContext contents fileName
  let (_, parserState, msgs) ← Parser.parseHeader inputCtx
  let pmctx : Parser.ParserModuleContext := { env, options := {} }
  let mut state := parserState
  let mut msgs := msgs
  let mut currNamespace : Name := .anonymous
  let mut scopes : Array ParseScope := #[]
  let mut opens : Array Syntax := #[]
  let mut examples := #[]
  repeat
    let (stx, state', msgs') := Parser.parseCommand inputCtx pmctx state msgs
    state := state'
    msgs := msgs'
    if Parser.isTerminalCommand stx then
      break
    if stx.isOfKind ``Parser.Command.namespace then
      for _ in [0:stx[1].getId.getNumParts] do
        scopes := scopes.push { isNamespace := true, opensLen := opens.size }
      currNamespace := currNamespace ++ stx[1].getId
    else if stx.isOfKind ``Parser.Command.section then
      scopes := scopes.push { isNamespace := false, opensLen := opens.size }
    else if stx.isOfKind ``Parser.Command.end then
      let count := match stx[1].getOptional? with
        | none => 1
        | some id => id.getId.getNumParts
      for _ in [0:count] do
        if let some scope := scopes.back? then
          scopes := scopes.pop
          opens := opens.shrink scope.opensLen
          if scope.isNamespace && !currNamespace.isAnonymous then
            currNamespace := currNamespace.getPrefix
    else if stx.isOfKind ``Parser.Command.open then
      opens := opens.push stx[1]
    else
      let (decl, extraOpens) := unwrapCommandIn stx
      if isExampleCommand decl then
        if let some range := stx.getRange? then
          -- The signature is everything before the body: through the end of
          -- `optDeclSig`, or of the `example` keyword when the signature is empty.
          let optDeclSig := decl[1][1]
          let sigStop := optDeclSig.getTailPos? <|> decl[1][0].getTailPos? |>.getD range.stop
          examples := examples.push {
            decl
            opens := opens ++ extraOpens
            currNamespace
            signature := Substring.Raw.toString ⟨contents, range.start, sigStop⟩
            declarationRange := toDeclarationRange inputCtx.fileMap range
          }
  return examples

open Lean.Elab in
/--
Re-elaborates the signature (binders and type — never the body) of a parsed `example`
in the current environment and pretty-prints it like a declaration signature.

Auto-bound implicits are disabled so that an example depending on names we cannot see
(most commonly section `variable`s, which the parse pass does not reconstruct) fails
here — and falls back to showing its source — rather than rendering a signature the
source does not have.
-/
private def elabExampleSignature (raw : RawExample) : MetaM (Array Arg × RenderedCode) := do
  let optDeclSig := raw.decl[1][1]
  let some typeSpec := optDeclSig[1].getOptional?
    | throwError "example without a type ascription"
  let go : TermElabM Expr := do
    -- Bring the collected `open`s into scope, individually and best-effort: one
    -- unresolvable `open` shouldn't take down the others.
    let mut openDecls ← getOpenDecls
    for o in raw.opens do
      try
        openDecls ← withTheReader Core.Context ({ · with openDecls }) <|
          OpenDecl.elabOpenDecl ⟨o⟩
      catch _ =>
        pure ()
    withTheReader Core.Context ({ · with openDecls }) do
      Term.withoutErrToSorry <| Term.elabBinders optDeclSig[0].getArgs fun xs => do
        let type ← Term.elabType typeSpec[1]
        Term.synthesizeSyntheticMVarsNoPostponing
        let type ← instantiateMVars type
        let e ← Meta.mkForallFVars xs type
        if e.hasSorry || e.hasMVar then
          throwError "example signature contains sorry or unsolved metavariables"
        return e
  let e ←
    withTheReader Core.Context ({ · with currNamespace := raw.currNamespace }) <|
      withOptions (fun opts => relaxedAutoImplicit.set (autoImplicit.set opts false) false) <|
        go.run'
  prettySignature e raw.currNamespace

/--
Collect the `example` declarations of `module` by parsing its source file, found via the
`LEAN_SRC_PATH` search path (set by Lake). Returns `#[]` when the source file cannot be
located or read, so missing sources degrade to "no examples" instead of failing the
build. Examples whose signature cannot be re-elaborated degrade to their signature
source text.
-/
def extractExamples (module : Name) : MetaM (Array ExampleDecl) := do
  let fileName? ← try
    let path ← findLean (← getSrcSearchPath) module
    if ← path.pathExists then pure (some path) else pure none
  catch _ =>
    pure none
  let some fileName := fileName? | return #[]
  let raws ← try
    parseExampleCommands (← getEnv) fileName.toString (← IO.FS.readFile fileName)
  catch e =>
    IO.println s!"WARNING: Failed to extract examples from {fileName}: {← e.toMessageData.toString}"
    return #[]
  raws.mapM fun raw => do
    let (args, type) ← tryCatchRuntimeEx
      (do
        let (args, type) ← elabExampleSignature raw
        pure (args, some type))
      (fun e => do
        IO.println s!"WARNING: falling back to source text for example at \
          {module}:{raw.declarationRange.pos.line}: {← e.toMessageData.toString}"
        pure (#[], none))
    return {
      args, type
      signature := raw.signature
      declarationRange := raw.declarationRange
    }

end DocGen4.Process
