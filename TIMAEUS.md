# doc-gen4 (timaeus fork)

Fork of [`leanprover/doc-gen4`](https://github.com/leanprover/doc-gen4) at tag
`v4.29.0`, patched so that a Mathlib-importing project can publish docs for **its
own modules only** while still linking references to Mathlib/core declarations
out to the already-hosted Mathlib docs.

Upstream `lake build <Lib>:docs` emits one HTML page (plus source mirror and
per-module search shard) for **every module in the transitive import closure** —
for any Mathlib downstream that is the whole of Mathlib, ~hundreds of thousands
of files and a multi-GB search index. That blows past Cloudflare Pages limits
(20,000 files free / 100,000 paid, 25 MiB/file) and is wasteful when Mathlib
docs are already hosted.

## What the fork changes

Three env-var-gated behaviours (with none set they are byte-identical to
upstream), plus `example` rendering, which is on by default. See `Main.lean`,
`DocGen4/Output.lean`, `DocGen4/Output/Base.lean`, `DocGen4/DB.lean`.

### `DOCGEN_LOCAL_ROOTS` — trim emitted modules + search index

Comma-separated top-level module roots considered "local" (e.g.
`Laplace,Common,Threepoint`). In `runFromDbCmd`, after the transitive closure is
computed, `targetModules` is filtered to modules whose root is in this list.
Because per-module HTML **and** the per-module search shard are only written for
`targetModules` (merged by `htmlOutputIndex`), this single filter trims **both**
the page count and the search index to the local project.

### `DOCGEN_EXTERNAL_BASE` — redirect external *module* links

Base URL (e.g. `https://leanprover-community.github.io/mathlib4_docs/`). In
`moduleNameToLink`, any module whose root is not in `localRoots` has its link
rewritten to `<base>/Module/Path.html`. doc-gen4's module→path scheme matches
the hosted site, so module links (import lists etc.) resolve without any extra
data.

### `DOCGEN_EXTERNAL_DECL_DATA` — resolve external *declaration* links

Path to a `name\tdocLink` TSV — the external **address book**. In
`renderedCodeToHtmlAux` (`.const` case), a declaration name that is **not** in
the local database's `name2ModIdx` is looked up here; if found, it links to
`<DOCGEN_EXTERNAL_BASE>/<docLink>`. This is what lets the emitted database
contain **only the project's own modules**: references to Mathlib/core decls are
resolved from this book rather than from a locally-built Mathlib database.

The book is produced from Mathlib's own published
`declarations/declaration-data.bmp` (see the `tide-docs` skill). Because we
resolve links from the **same** data we redirect **to**, every emitted link
points exactly where the hosted site currently serves that declaration.

### `example` declarations — rendered from the source (`DOCGEN_EXAMPLES`)

Lean elaborates `example` inside `withoutModifyingEnv` (`Lean.Elab.MutualDef`),
so examples never persist in the environment or olean — upstream doc-gen4,
which enumerates `env.constants`, cannot see them and silently drops them from
module pages. The fork recovers them by re-parsing each module's source file
(parser only, no elaboration; `Process.collectExamples` in
`DocGen4/Process/Analyze.lean`), storing their raw source text in the DB
(`examples` table), and rendering each as a declaration-style block titled
"example" with the source in a code block, interleaved with the other members
in source order. The source file is located via `LEAN_SRC_PATH` (set by Lake);
if it cannot be found, a warning is printed and that module simply has no
examples. On by default for project ingestion (`single`/`ingest`); skipped for
`genCore`; set `DOCGEN_EXAMPLES=0` to disable. Examples are anonymous, so they
never appear in the search index, nav, or dep atlas.

## No base DB: what the emitted database contains

Earlier iterations built a shared "base DB" of all Mathlib's `docInfo` (~50 min,
~700 MB) and ingested each repo's modules on top. That is gone. The emitted
database now contains **only the repo's own modules** (ingested from its
oleans); everything external is resolved from `DOCGEN_EXTERNAL_DECL_DATA`. There
is no Mathlib in any database we build or host — Mathlib publishes the address
book, we just consume it.

## Version skew (known drawback)

The hosted `mathlib4_docs` tracks Mathlib **master** (currently Lean 4.32.x),
while these repos pin `v4.29.0`, and **Mathlib hosts docs for `latest` only** —
there is no per-version archive (verified: version-path URLs 404, the deployment
repo has no version tags). So we cannot do the ideal thing:

> host per-version docs, set `DOCGEN_EXTERNAL_BASE` / the address book to *that*
> version, and get both `.bmp` and links from an exact match.

What we do instead — master `.bmp` + master redirect — is **internally
consistent** (links always match where the live site serves each name), so the
residual `v4.29.0`↔master gap has only two failure modes:

1. **Renamed / removed / newly-private decl** → absent from the master `.bmp` →
   the reference renders as **plain text (no link)**. Graceful; never a broken
   link. Empirically zero genuine mathematical decls for laplace today (the only
   misses are tactic/meta names and non-name artifacts).
2. **Same fully-qualified name, changed statement** → the link resolves, but to
   master's (possibly different) version of that declaration. This is the one
   **misleading** case: the reader could see a definition that differs from the
   one the repo was actually built against. Rare for the stable core API, but
   real. There is no automatic guard — it is the price of linking to a moving
   target.

**Escape hatch** (short of hosting all of Mathlib): serve a snapshot of the
`mathlib4_docs` deployment repo from the `v4.29.0` era under therisensea (e.g.
`/mathlib-v4.29.0/`) and point `DOCGEN_EXTERNAL_BASE` + the address-book source
at it — a one/two-line change in the `tide-docs` skill. It is a large static
tree, and current coverage is effectively complete, so it is not worth it yet;
this note is here so a future maintainer knows the option exists and why.

## The dep atlas (`billy-lean/dep-atlas`)

Declaration-level dependency views woven into the emitted docs. Three pieces:

**Extraction** (`DocGen4/Process/DepGraph.lean`, hooked into `Process.process`):
for every rendered declaration, the used constants of its *type* and of its
*value* are collected separately and collapsed to human-facing declarations —
references to match auxiliaries, equation lemmas, `_proof_N`, private helpers
are transitively replaced by their own dependencies; constructors, projections
(field and parent), recursors and `noConfusion` are attributed to their parent
type. For inductives/structures the constructor signatures count as part of the
type. Each record also notes whether the value is a proof (`theorem` or
`Prop`-valued). Stored in two DB tables (`dep_nodes`, `dep_edges`).

The type/value split is the point (cf. Lean Atlas, arXiv:2604.16347). Two edge
relations are derived client-side:

* **meaning** = type edges + value edges of non-proofs. If a definition is
  *wrong* (typechecks but says the wrong thing), the tainted set is backwards
  reachability along meaning edges — proofs that merely *use* lemmas about it
  are not tainted, their statements don't mention it.
* **proof** = all edges. If a lemma is *false*, backwards reachability here is
  what's unproven.

**Emission** (`DocGen4/Output/DepGraph.lean`, run by `fromDb`): writes
`declarations/depgraph.json` (nodes = emitted declarations, edge targets
resolved to node indices; external targets resolved through the same address
book as HTML links, so the frontier points at hosted Mathlib docs; external
value-deps of proofs are dropped as pure noise). `fromDb` now also emits
`declarations/header-data.bmp` (signature HTML per declaration) which the
panels render from.

**Views** (all client-side, `static/depgraph*.js`, `static/atlas.js`):

* every declaration page: a `deps` toggle (statement closure: everything the
  statement's meaning rests on, one readable list in dependency order, with
  signatures, instances collapsed, external frontier as chips) and a `used by`
  toggle (blast radius: meaning-dependents counted and grouped into module
  prefix clusters — reads as "the X and Y stuff, not the Z stuff" — plus the
  count of proof-only dependents).
* `atlas.html` (navbar: "dependency atlas"): *core* (declarations ranked by
  meaning mass = how many statements transitively rest on them), *map*
  (force-directed module map, deterministic precomputed layout, cluster or
  per-module granularity, nodes colored by name-prefix cluster), *module
  matrix* (module × module DSM in topological order, canvas, click for the
  crossing references), *declaration* (search + closure DAG + both panels;
  deep-linkable via `atlas.html#decl=Name`).

Known rough edges: names renamed/removed on Mathlib master render as unlinked
chips (same version-skew as HTML links); mutual definitions form 2-cycles that
mass ranking tolerates but does not condense; `genCore` would run extraction
over all of core (unused by us).

Dev gotcha: the JS/CSS in `static/` is embedded into the binary via
`include_str`, and Lake does **not** track those files as module inputs. After
editing `static/`, force a rebuild of the embedding module:
`find .lake/build -name "Base.*" -path "*Output*" -delete && lake build doc-gen4`
(from a docbuild dir), or `lake clean` the package.

## Usage

The build/publish orchestration lives in the **`tide-docs` skill**
(`sri/.agents/skills/tide-docs/`), not in this repo. It scaffolds a per-repo
`docbuild/` (reusing the repo's built `../.lake/packages`), fetches the address
book, ingests the repo's own modules into a fresh database, emits the trimmed
site with the three env vars set, and publishes to `therisensea.org/docs/<slug>/`.
Run `uv run --script tide-docs`.

Two subtleties `tide-docs` handles:

- It ingests **every built module** of the lib (`ingest` command, one env load),
  not just the transitive closure of the root aggregator — doc-gen4's `<Lib>:docs`
  facet documents only what `<Lib>.lean` imports, and laplace has 16 modules (a
  WIP Anharmonic-FDT cluster) not imported by it. Enumerating built `.olean`s
  covers them.
- Local dependency repos (lean-common, threepoint) are only partially built, so
  it filters to modules with a built `.olean`; the built set is import-closed, so
  no dead links result.

## Verified result (laplace)

- 68/68 Laplace source modules documented (incl. the 16 orphans), + the used
  Common/Threepoint modules. **80 pages, ~4 MB**; search index of the local
  declarations only, zero Mathlib.
- Emitted database holds only the local modules; Mathlib links resolved from the
  address book. Sampled external links resolve on the live site with anchors.
- Self-contained relative links (`SITE_ROOT="./"`): deploys unchanged under
  `therisensea.org/docs/laplace/`.
