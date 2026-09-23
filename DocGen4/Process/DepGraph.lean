/-
timaeus fork: declaration-level dependency extraction for the dep atlas.

For every rendered declaration we record which other *human-facing* declarations
its statement (type) and its value (body / proof) refer to. Auto-generated
constants (match auxiliaries, equation lemmas, `_proof_N`, private helpers, ...)
are not nodes: references to them are transitively replaced by their own
dependencies. Constructors, projection functions, recursors and `noConfusion`
are attributed to their parent type.

The type/value split is the load-bearing distinction (cf. Lean Atlas,
arXiv:2604.16347): a *definition's* meaning depends on both its signature and
its body, while a *theorem's* meaning depends only on its statement — the value
is a kernel-checked proof whose dependencies are truth-relevant, not
meaning-relevant. `DepEntry.propValue` records which case we are in, so
consumers can build the "meaning graph" (type edges everywhere + value edges
out of non-propositional declarations) or the "proof graph" (all edges).
-/
import Lean
import DocGen4.Process.Base
import DocGen4.Process.DocInfo

namespace DocGen4.Process

open Lean Meta

/-- One rendered declaration's collapsed dependency record. -/
structure DepEntry where
  name : Name
  /-- The value is a proof (`theorem` or `Prop`-valued definition): its
  value-site dependencies do not carry meaning, only truth. -/
  propValue : Bool
  /-- Dependencies of the statement/signature. For inductives and structures
  this includes the constructor signatures (they are the meaning). -/
  typeDeps : Array Name
  /-- Dependencies appearing only at the value site (body or proof). -/
  valueDeps : Array Name
  deriving Inhabited

namespace DepGraph

/-- Equation-lemma-style helper names that `Name.isInternalDetail` misses. -/
private def isEquationLemmaLike : Name → Bool
  | .str _ s => s == "eq_def" || s == "eq_unfold" || s == "_sunfold"
  | _ => false

/--
Context for resolving raw used-constant names to graph nodes.

`renderedSet` is the exact set of declarations the current analysis run renders,
and `isRelevantModule` marks the modules of that run. Names inside relevant
modules are classified exactly; names outside (Mathlib/core, or sibling repos
ingested in a different run) are classified by the same heuristics doc-gen4's
blacklist uses, so agreement with what a docs site actually renders is high.
-/
structure ResolveCtx where
  env : Environment
  renderedSet : Std.HashSet Name
  isRelevantModule : Name → Bool

/-- Memoized results: raw constant name → node names it stands for. -/
abbrev ResolveM := StateRefT (Std.HashMap Name (Array Name)) MetaM

private def moduleOf? (env : Environment) (n : Name) : Option Name := do
  let idx ← env.getModuleIdxFor? n
  env.header.moduleNames[idx.toNat]?

/--
Resolve one raw used-constant name to the set of graph nodes it stands for.
`path` maps each name on the current DFS path to its depth, guarding against
reference cycles among internal helpers (mutual definitions and their
auxiliaries). The returned `Option Nat` is the shallowest path depth a cycle
was cut at, lowlink-style: a result whose only cycles route back to `n` itself
is path-independent and safe to memoize; a result cut at a shallower ancestor
is not, and is recomputed on the next approach.
-/
private partial def resolve (ctx : ResolveCtx) (path : Std.HashMap Name Nat) (n : Name) :
    ResolveM (Array Name × Option Nat) := do
  if let some cached := (← get)[n]? then
    return (cached, none)
  if let some depth := path[n]? then
    return (#[], some depth)
  let myDepth := path.size
  let (result, cut?) ← compute (path.insert n myDepth)
  let cut? := cut?.bind fun d => if d < myDepth then some d else none
  if cut?.isNone then
    modify (·.insert n result)
  return (result, cut?)
where
  compute (path : Std.HashMap Name Nat) : ResolveM (Array Name × Option Nat) := do
    let env := ctx.env
    let some ci := env.find? n | return (#[], none)
    -- Attribute generated companions to their parent type.
    match ci with
    | .ctorInfo v => return ← resolve ctx path v.induct
    | .recInfo v => return ← resolve ctx path v.getMajorInduct
    | _ => pure ()
    if isAuxRecursor env n || isNoConfusion env n then
      return ← resolve ctx path n.getPrefix
    -- Projection functions (fields, and synthesized parent projections like
    -- `Monoid.toPow`) are attributed to their structure. `DocInfo.isProjFn` is
    -- the same predicate the renderer uses, so attribution stays in sync with
    -- what pages actually show.
    if ← DocInfo.isProjFn n then
      return ← resolve ctx path n.getPrefix
    -- Exact classification for names in the analyzed modules.
    if let some m := moduleOf? env n then
      if ctx.isRelevantModule m then
        if ctx.renderedSet.contains n then
          return (#[n], none)
        else
          return ← expandThrough ci path
    -- Heuristic classification for everything else.
    if (privatePrefix? n).isSome || n.isInternalDetail || isEquationLemmaLike n
        || isMatcherCore env n then
      return ← expandThrough ci path
    return (#[n], none)

  /-- Replace an internal helper by the union of its own dependencies. -/
  expandThrough (ci : ConstantInfo) (path : Std.HashMap Name Nat) :
      ResolveM (Array Name × Option Nat) := do
    let raw := ci.type.getUsedConstants ++ (ci.value?.map (·.getUsedConstants)).getD #[]
    let mut acc : Std.HashSet Name := {}
    let mut cut? : Option Nat := none
    for c in raw do
      let (rs, c?) ← resolve ctx path c
      if let some d := c? then
        cut? := some (min d (cut?.getD d))
      for r in rs do
        acc := acc.insert r
    return (acc.toArray, cut?)

/-- Resolve a set of raw used constants, dropping `self` (and anything that
attributes back to it, e.g. its own constructors). -/
private def resolveAll (ctx : ResolveCtx) (self : Name) (raw : Array Name) :
    ResolveM (Array Name) := do
  let mut acc : Std.HashSet Name := {}
  for c in raw do
    for r in (← resolve ctx ({} : Std.HashMap Name Nat) c).1 do
      if r != self then
        acc := acc.insert r
  return acc.toArray.qsort Name.lt

/--
The statement-site and value-site raw constants of a declaration.

For inductives (and structures/classes, which are inductives) the constructor
signatures belong to the statement: they *are* the definition's content.
-/
private def rawDeps (env : Environment) (ci : ConstantInfo) : Array Name × Array Name :=
  match ci with
  | .inductInfo v => Id.run do
    let mut typeRaw := v.type.getUsedConstants
    for ctor in v.ctors do
      if let some (.ctorInfo cv) := env.find? ctor then
        typeRaw := typeRaw ++ cv.type.getUsedConstants
    return (typeRaw, #[])
  | _ =>
    (ci.type.getUsedConstants, (ci.value?.map (·.getUsedConstants)).getD #[])

/-- Compute the `DepEntry` for one rendered declaration. -/
def depEntryFor (ctx : ResolveCtx) (name : Name) : ResolveM (Option DepEntry) := do
  let some ci := ctx.env.find? name | return none
  let (typeRaw, valueRaw) := rawDeps ctx.env ci
  let typeDeps ← resolveAll ctx name typeRaw
  let valueAll ← resolveAll ctx name valueRaw
  let typeSet := Std.HashSet.emptyWithCapacity typeDeps.size |>.insertMany typeDeps
  let valueDeps := valueAll.filter (!typeSet.contains ·)
  let propValue ←
    match ci with
    | .thmInfo _ => pure true
    | .inductInfo _ => pure false
    -- tryCatchRuntimeEx, not try/catch: `isProp` can hit the deterministic
    -- heartbeat limit on huge types, and that is a runtime exception.
    | _ => tryCatchRuntimeEx (Meta.isProp ci.type) fun _ => pure false
  return some { name, propValue, typeDeps, valueDeps }

end DepGraph
end DocGen4.Process
