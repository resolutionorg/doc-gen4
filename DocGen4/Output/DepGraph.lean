/-
timaeus fork: dep atlas output — `declarations/depgraph.json` plus the
`atlas.html` page shell. The graph views themselves are client-side
(`static/depgraph.js`, `static/depgraph-decl.js`, `static/atlas.js`).
-/
import DocGen4.Output.ToHtmlFormat
import DocGen4.Output.Template
import DocGen4.Output.ToJson
import SQLite

namespace DocGen4
namespace Output

open scoped DocGen4.Jsx
open Lean

/--
Emit `declarations/depgraph.json`: the collapsed declaration-level dependency
graph over the emitted (local) modules.

Nodes are the declarations that appear both in the emitted modules
(`jsonModules`, already trimmed to `DOCGEN_LOCAL_ROOTS`) and in the DB's
`dep_nodes` table. Edge targets that are not nodes are external: their doc
links are resolved through the same address book used for HTML links, so the
frontier of a statement closure points at the hosted Mathlib docs. External
value-site dependencies of proof-valued declarations (i.e. which Mathlib lemmas
a proof uses) are deliberately dropped — no view needs them and they are the
bulk of the raw edge set.

Format (all arrays index-aligned, node/external references by index):
```
{ "v": 1,
  "modules": ["Pas.Basic", ...],
  "external": [["Finset.sum", "https://..."], ["Weird.name", null], ...],
  "nodes": [ { "n": name, "k": kind, "m": moduleIdx, "l": line,
               "s": sorried?, "p": propValue?,
               "td": [nodeIdx...], "vd": [nodeIdx...],
               "xt": [extIdx...],  "xv": [extIdx...] } ] }
```
-/
def depGraphOutput (baseConfig : SiteBaseContext) (dbPath : System.FilePath)
    (jsonModules : Array JsonModule) : IO Unit := do
  let db ← SQLite.openWith dbPath .readonly (busyTimeoutMs := 1800000)

  let mut propValue : Std.HashMap String Bool := {}
  let nodesStmt ← db.prepare "SELECT name, prop_value FROM dep_nodes"
  while ← nodesStmt.step do
    propValue := propValue.insert (← nodesStmt.columnText 0) ((← nodesStmt.columnInt64 1) != 0)

  let mut sorried : Std.HashSet String := {}
  let sorriedStmt ← db.prepare "SELECT name FROM name_info WHERE sorried = 1"
  while ← sorriedStmt.step do
    sorried := sorried.insert (← sorriedStmt.columnText 0)

  let mut typeEdges : Std.HashMap String (Array String) := {}
  let mut valueEdges : Std.HashMap String (Array String) := {}
  let edgesStmt ← db.prepare "SELECT source, target, is_type FROM dep_edges"
  while ← edgesStmt.step do
    let source ← edgesStmt.columnText 0
    let target ← edgesStmt.columnText 1
    if (← edgesStmt.columnInt64 2) != 0 then
      typeEdges := typeEdges.insert source ((typeEdges.getD source #[]).push target)
    else
      valueEdges := valueEdges.insert source ((valueEdges.getD source #[]).push target)

  -- Node index: emitted declarations that have a dependency record.
  let mut nodeIdx : Std.HashMap String Nat := {}
  let mut nodeInfos : Array (JsonDeclarationInfo × Nat) := #[]
  for h : m in 0...jsonModules.size do
    for decl in jsonModules[m].declarations do
      if propValue.contains decl.info.name && !nodeIdx.contains decl.info.name then
        nodeIdx := nodeIdx.insert decl.info.name nodeInfos.size
        nodeInfos := nodeInfos.push (decl.info, m)

  -- Externals: edge targets that are not nodes, with address-book links.
  let mut extIdx : Std.HashMap String Nat := {}
  let mut externals : Array (String × Option String) := #[]
  let mut nodesJson : Array Json := #[]
  for (info, modIdx) in nodeInfos do
    let isProof := propValue.getD info.name false
    let mut refs : Array (Array Json) := #[#[], #[], #[], #[]]  -- td, vd, xt, xv
    for (targets, isType) in [(typeEdges.getD info.name #[], true),
                              (valueEdges.getD info.name #[], false)] do
      for target in targets do
        match nodeIdx[target]? with
        | some i =>
          refs := refs.modify (if isType then 0 else 1) (·.push (toJson i))
        | none =>
          -- External proof dependencies carry no meaning; drop them.
          if !isType && isProof then continue
          let i ← match extIdx[target]? with
            | some i => pure i
            | none =>
              let link := (externalDeclLink? target.toName).run baseConfig
              extIdx := extIdx.insert target externals.size
              externals := externals.push (target, link)
              pure (externals.size - 1)
          refs := refs.modify (if isType then 2 else 3) (·.push (toJson i))
    nodesJson := nodesJson.push <| Json.mkObj [
      ("n", toJson info.name), ("k", toJson info.kind), ("m", toJson modIdx), ("l", toJson info.line),
      ("s", toJson (sorried.contains info.name)), ("p", toJson isProof),
      ("td", Json.arr refs[0]!), ("vd", Json.arr refs[1]!),
      ("xt", Json.arr refs[2]!), ("xv", Json.arr refs[3]!)
    ]

  let json := Json.mkObj [
    ("v", toJson (1 : Nat)),
    ("modules", toJson (jsonModules.map (·.name))),
    ("external", Json.arr <| externals.map fun (n, l) =>
      Json.arr #[toJson n, toJson l]),
    ("nodes", Json.arr nodesJson)
  ]
  let declarationDir := basePath baseConfig.buildDir / "declarations"
  IO.FS.createDirAll declarationDir
  IO.FS.writeFile (declarationDir / "depgraph.json") json.compress
  IO.println s!"timaeus: dep atlas: {nodesJson.size} nodes, {externals.size} external refs"

/-- The dependency atlas page. All content is rendered by `atlas.js` from
`declarations/depgraph.json`. -/
def depAtlas : BaseHtmlM Html := do templateExtends (baseHtml "Dependency atlas") <| do
  pure
    <main id="atlas_main">
      <h1>Dependency atlas</h1>
      <p id="atlas_intro">
        {.raw "The declaration-level dependency structure of this project. \
<b>Meaning</b> edges follow statements (and definition bodies); <b>proof</b> \
edges additionally follow what proofs use. Pick a declaration to see what its \
statement rests on and what rests on it, or study the load-bearing core and \
the module matrix."}
      </p>
      <div id="atlas_app">Loading dependency data…</div>
      <script type="module" src="./atlas.js"></script>
    </main>

end Output
end DocGen4
