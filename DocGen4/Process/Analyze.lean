/-
Copyright (c) 2022 Henrik Böving. All rights reserved.
Released under Apache 2.0 license as described in the file LICENSE.
Authors: Henrik Böving
-/

import Lean.Elab.Tactic.Doc
import Lean.Meta.Basic
import Lean.Parser.Extension
import Std.Data.HashMap
import Std.Data.HashSet

import DocGen4.Process.Base
import DocGen4.Process.Hierarchy
import DocGen4.Process.DocInfo
import DocGen4.Process.DepGraph
import DocGen4.Process.Examples

namespace DocGen4.Process

open Lean Meta
open Lean.Elab.Tactic.Doc

/-- Represents a non-verso docstring; these will be rendered using `Output.docStringToHtml`. -/
abbrev MarkdownDocstring := String

/--
Member of a module, either a declaration or some module doc string.
-/
inductive ModuleMember where
| docInfo (info : DocInfo) : ModuleMember
| modDoc (doc : ModuleDoc) : ModuleMember
| exampleDecl (ex : ExampleDecl) : ModuleMember
deriving Inhabited

/-- Information about a tactic declaration which will be rendered on the Tactics page.

This datastructure contains slightly different contents compared to a `TacticDoc` to make
it easily serializable as JSON. It is designed to be easy to instantiate,
using `{ tacticDoc with ... }`.
-/
structure TacticInfo (textType : Type) where
  /-- The name of the canonical parser for the tactic -/
  internalName : Name
  /-- The user-facing name to display (typically the first keyword token) -/
  userName : String
  /-- The tags that have been applied to the tactic -/
  tags : Array Name
  /-- The docstring for the tactic, including any extension docstrings. -/
  docString : textType
  /-- Name of the module where the tactic is declared. -/
  definingModule : Name
deriving FromJson, ToJson

/--
A Lean module.
-/
structure Module where
  /--
  Name of the module.
  -/
  name : Name
  /--
  All members of the module, sorted according to their line numbers.
  -/
  members : Array ModuleMember
  imports : Array Name
  /--
  Tactics declared in this module.
  -/
  tactics : Array (TacticInfo MarkdownDocstring)
  deriving Inhabited

/--
The result of running a full doc-gen analysis on a project.
-/
structure AnalyzerResult where
  /--
  The map from module names to indices of the `moduleNames` array.
  -/
  name2ModIdx : Std.HashMap Name ModuleIdx
  /--
  The list of all modules, accessible nicely via `name2ModIdx`.
  -/
  moduleNames : Array Name
  /--
  A map from module names to information about these modules.
  -/
  moduleInfo : Std.HashMap Name Module
  /--
  For each rendered declaration, the set of names whose declaration ranges are contained within it.
  Used to determine whether auto-generated projections should receive anchor IDs in the HTML output.

  This field is only populated when the result is read from the database. Prior to that, it is
  empty.
  -/
  containedNames : Std.HashMap Name (Std.HashSet Name) := {}
  /--
  timaeus fork: collapsed dependency records per module, for the dep atlas.
  Only populated during analysis (`process`); empty when read back from the
  database (the `fromDb` command reads the dep tables directly).
  -/
  deps : Std.HashMap Name (Array DepEntry) := {}
  deriving Inhabited

namespace ModuleMember

def getDeclarationRange : ModuleMember → DeclarationRange
| docInfo i => i.getDeclarationRange
| modDoc i => i.declarationRange
| exampleDecl i => i.declarationRange

/--
An order for module members, based on their declaration range.
-/
def order (l r : ModuleMember) : Bool :=
  Position.lt l.getDeclarationRange.pos r.getDeclarationRange.pos

def getName : ModuleMember → Name
| docInfo i => i.getName
| modDoc _ => Name.anonymous
| exampleDecl _ => Name.anonymous

def getDocString : ModuleMember → Option (String ⊕ VersoDocString)
| docInfo i => i.getDocString
| modDoc i => some (.inl i.doc)
| exampleDecl _ => none

def shouldRender : ModuleMember → Bool
| docInfo i => i.shouldRender
| modDoc _ => true
| exampleDecl _ => true

end ModuleMember

inductive AnalyzeTask where
| analyzePrefixModules (topLevel : Name) : AnalyzeTask
| analyzeConcreteModules (modules : Array Name) : AnalyzeTask

def AnalyzeTask.getLoad (task : AnalyzeTask) : Array Name :=
  match task with
  | .analyzePrefixModules topLevel => #[topLevel]
  | .analyzeConcreteModules modules => modules

/-- Collect tactic info for pages to display in addition to the module docs. -/
def collectTactics (module : Name) (env : Environment) :
    MetaM (Array (TacticInfo MarkdownDocstring)) := do
  let docs ← Elab.Tactic.Doc.allTacticDocs
  let mut contents := #[]
  for doc in docs do
    let some modIdx := env.getModuleIdxFor? doc.internalName | continue
    let definingModule := env.header.moduleNames[modIdx]!
    if module != definingModule then continue
    contents := contents.push {
      doc with
      docString := doc.docString.getD "This tactic has no documentation." ++
        ("\n\n".intercalate doc.extensionDocs.toList)
      tags := doc.tags.toArray,
      definingModule := definingModule,
    }
  return contents

def getAllModuleDocs (relevantModules : Array Name) : MetaM (Std.HashMap Name Module) := do
  let env ← getEnv
  let mut res := Std.HashMap.emptyWithCapacity relevantModules.size
  for module in relevantModules do
    let modDocs := getModuleDoc? env module |>.getD #[] |>.map .modDoc
    let some modIdx := env.getModuleIdx? module | unreachable!
    let moduleData := env.header.moduleData[modIdx]!
    let imports := moduleData.imports.map Import.module
    let tactics ← collectTactics module env
    res := res.insert module <| Module.mk module modDocs imports tactics
  return res

def mkOptions : IO DocGenOptions := do
  match ← IO.getEnv "DISABLE_EQUATIONS" with
  | some "1" => return ⟨false⟩
  | _ => return {}

/--
Run the doc-gen analysis on all modules that are loaded into the `Environment`
of this `MetaM` run and mentioned by the `AnalyzeTask`.
-/
def process (task : AnalyzeTask) : MetaM AnalyzerResult := do
  let env ← getEnv
  let allModules := env.header.moduleNames
  let relevantModules :=
    match task with
    | .analyzePrefixModules topLevel =>
      let modules := allModules.filter (topLevel.isPrefixOf ·)
      Std.HashSet.insertMany (Std.HashSet.emptyWithCapacity modules.size) modules
    | .analyzeConcreteModules modules =>
      Std.HashSet.insertMany (Std.HashSet.emptyWithCapacity modules.size) modules

  let mut res ← getAllModuleDocs relevantModules.toArray

  let options ← liftM mkOptions

  for (name, cinfo) in env.constants do
    let some modidx := env.getModuleIdxFor? name | unreachable!
    let moduleName := allModules[modidx]!
    if !relevantModules.contains moduleName then
      continue

    res ← tryCatchRuntimeEx
      (do
        let config := {
          maxHeartbeats := 5000000,
          options := ← getOptions,
          fileName := ← getFileName,
          fileMap := ← getFileMap,
        }
        let analysis ← Prod.fst <$> ((DocInfo.ofConstant (name, cinfo)).run options).toIO config { env := env } {} {}
        if let some dinfo := analysis then
          let moduleName := allModules[modidx]!
          let module := res[moduleName]!
          return res.insert moduleName {module with members := module.members.push (ModuleMember.docInfo dinfo)}
        else
          return res
      )
      (fun e => do
        if let some pos := e.getRef.getPos? then
          let pos := (← getFileMap).toPosition pos
          IO.println s!"WARNING: Failed to obtain information in file: {pos}, for: {name}, {← e.toMessageData.toString}"
        else
          IO.println s!"WARNING: Failed to obtain information for: {name}: {← e.toMessageData.toString}"
        return res
      )

  -- timaeus fork: parser-only pass collecting `example` commands from each module's
  -- source file. Examples never reach the environment (they are elaborated inside
  -- `withoutModifyingEnv`), so this is the only way to show them. Mirrors the dep
  -- extraction gating below: skipped for the prefix task (`genCore`) and when
  -- DOCGEN_EXAMPLES=0. Failures degrade to "no examples" per module.
  let examplesEnabled := (← IO.getEnv "DOCGEN_EXAMPLES") != some "0"
  if examplesEnabled && task matches .analyzeConcreteModules _ then
    for (moduleName, module) in res.toArray do
      let examples ← extractExamples moduleName
      if !examples.isEmpty then
        res := res.insert moduleName
          { module with members := module.members ++ examples.map ModuleMember.exampleDecl }

  -- TODO: This could probably be faster if we did sorted insert above instead
  for (moduleName, module) in res.toArray do
    res := res.insert moduleName {module with members := module.members.qsort ModuleMember.order}

  -- timaeus fork: collapsed dependency extraction for the dep atlas. One shared
  -- memo across all modules; failures are contained per declaration, so one bad
  -- declaration costs its own entry, not the whole graph. Skipped for the
  -- prefix task (`genCore`) — extracting dependencies for all of Init/Std/Lean
  -- would be expensive and no view consumes them — and when DOCGEN_DEPGRAPH=0.
  let enabled := (← IO.getEnv "DOCGEN_DEPGRAPH") != some "0"
  let extract :=
    match task with
    | .analyzeConcreteModules _ => enabled
    | .analyzePrefixModules _ => false
  let deps ← if !extract then pure {} else do
    let mut renderedSet : Std.HashSet Name := {}
    for (_, module) in res do
      for mem in module.members do
        if let .docInfo i := mem then
          if i.shouldRender then
            renderedSet := renderedSet.insert i.getName
    let depCtx : DepGraph.ResolveCtx := {
      env
      renderedSet
      isRelevantModule := relevantModules.contains
    }
    let go : DepGraph.ResolveM (Std.HashMap Name (Array DepEntry)) := do
      let mut acc : Std.HashMap Name (Array DepEntry) := {}
      for (moduleName, module) in res do
        let mut entries := #[]
        for mem in module.members do
          if let .docInfo i := mem then
            if i.shouldRender then
              -- tryCatchRuntimeEx so heartbeat timeouts (runtime exceptions,
              -- invisible to plain try/catch) cost one entry, not the ingest.
              entries ← tryCatchRuntimeEx
                (do
                  if let some entry ← DepGraph.depEntryFor depCtx i.getName then
                    return entries.push entry
                  return entries)
                (fun e => do
                  IO.println s!"WARNING: dependency extraction failed for {i.getName}: {← e.toMessageData.toString}"
                  return entries)
        acc := acc.insert moduleName entries
      return acc
    go.run' {}

  return {
    name2ModIdx := env.const2ModIdx,
    moduleNames := allModules,
    moduleInfo := res,
    deps,
  }

open Std (Iterator Iter)

def filterDocInfo [Iterator α Id ModuleMember] (ms : @Iter α ModuleMember) :=
  ms.filterMap fun
    | ModuleMember.docInfo i => some i
    | _ => none

end DocGen4.Process
