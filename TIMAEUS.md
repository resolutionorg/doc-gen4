# doc-gen4 (Timaeus fork)

Fork of [`leanprover/doc-gen4`](https://github.com/leanprover/doc-gen4) at tag
`v4.33.1` (originally forked at `v4.29.0`), patched so that a Mathlib-importing project can publish docs for **its
own modules only** while still linking references to Mathlib/core declarations
out to the already-hosted Mathlib docs, and extended with declaration-level
dependency views (the *dependency atlas*).

Upstream `lake build <Lib>:docs` emits one HTML page (plus source mirror and
per-module search shard) for **every module in the transitive import closure** —
for any Mathlib downstream that is the whole of Mathlib, ~hundreds of thousands
of files and a multi-GB search index. That exceeds the file-count and file-size
limits of common static hosts (Cloudflare Pages, for instance, allows 20,000
files on its free plan, 100,000 on paid plans, and 25 MiB per file) and is
wasteful when Mathlib docs are already hosted.

Branches are named `timaeus/v4.<x>.<y>` after the upstream tag they are based
on. A project should require the branch (or a commit on it) that matches its Lean
toolchain.

## What the fork changes

Three env-var-gated link behaviours, an `ingest` command, a few link-hygiene
fixes, and the dependency atlas. See `Main.lean`, `DocGen4/Output.lean`,
`DocGen4/Output/Base.lean`, `DocGen4/DB.lean`, and for the atlas
`DocGen4/Process/DepGraph.lean`, `DocGen4/Output/DepGraph.lean` and `static/`.
With none of the env vars set, the emitted pages and links are those of upstream,
except for the atlas and the link-hygiene fixes below.

### `DOCGEN_LOCAL_ROOTS` — trim emitted modules + search index

Comma-separated top-level module roots considered "local" (e.g.
`MyProject,MyProjectExamples`). In `runFromDbCmd`, after the transitive closure is
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
`<DOCGEN_EXTERNAL_BASE>/<docLink>` (a leading `./` in `docLink` is dropped). This
is what lets the emitted database contain **only the project's own modules**:
references to Mathlib/core decls are resolved from this book rather than from a
locally-built Mathlib database.

The book is produced from Mathlib's own published
`declarations/declaration-data.bmp` (see [Usage](#usage)). Because links are
resolved from the **same** data they are redirected **to**, every emitted link
points exactly where the hosted site currently serves that declaration.

### `ingest` — many modules, one environment load

`doc-gen4 ingest [--build DIR] [--source-base URL] DB MODULE...` imports the
listed modules once (a single `importModules`), analyses each of them, and writes
them to the SQLite database `DB`. Each module's source link is derived from
`--source-base` (a GitHub blob base such as
`https://github.com/OWNER/REPO/blob/main/`), so all of a project's modules can be
added to a fresh database in one call, where upstream's `single` command handles
one module per environment load.

### Link hygiene in trimmed output

Upstream assumes every referenced declaration and module is in the database, which a
trimmed database breaks. Three places are adjusted so external or unknown targets go
through the address book or render unlinked instead of producing dead links:
inherited structure fields are not recorded in `internal_names` (the parent's module
owns the projection), inherited fields on structure pages resolve via
`externalDeclLink?`, and docstring code spans of the form `Path/To/Module.lean` link
only when that module is documented.

## No base DB: what the emitted database contains

An alternative design builds a shared "base DB" of all of Mathlib's `docInfo`
(about 50 minutes and 700 MB) and ingests each project's modules on top. The fork
avoids this: the emitted database contains **only the project's own modules**
(ingested from its oleans), and everything external is resolved from
`DOCGEN_EXTERNAL_DECL_DATA`. No Mathlib database is built or hosted — Mathlib
publishes the address book, and the build consumes it.

## Version skew (known drawback)

The hosted `mathlib4_docs` tracks Mathlib **master**, while a project typically
pins an older Lean and Mathlib release, and **Mathlib hosts docs for `latest`
only** — there is no per-version archive (version-path URLs 404, and the
deployment repository has no version tags). So the ideal arrangement is not
available:

> host per-version docs, set `DOCGEN_EXTERNAL_BASE` / the address book to *that*
> version, and get both `.bmp` and links from an exact match.

What the fork does instead — master `.bmp` + master redirect — is **internally
consistent** (links always match where the live site serves each name), so the
residual gap between the project's pinned version and master has only two failure
modes:

1. **Renamed / removed / newly-private decl** → absent from the master `.bmp` →
   the reference renders as **plain text (no link)**. Graceful; never a broken
   link. In practice the misses are mostly tactic and metaprogramming names and
   non-name artefacts rather than mathematical declarations.
2. **Same fully-qualified name, changed statement** → the link resolves, but to
   master's (possibly different) version of that declaration. This is the one
   **misleading** case: the reader could see a definition that differs from the
   one the project was actually built against. Rare for the stable core API, but
   real. There is no automatic guard — it is the price of linking to a moving
   target.

**Escape hatch** (short of hosting all of Mathlib): serve a snapshot of the
`mathlib4_docs` deployment repository from the matching era on your own host
(e.g. under `/mathlib-v4.33.1/`) and point `DOCGEN_EXTERNAL_BASE` and the
address-book source at it. It is a large static tree, and coverage from master is
usually close to complete, so it is rarely worth it; the option is recorded here
so that it is known to exist.

## The dependency atlas

Declaration-level dependency views woven into the emitted docs. Three pieces:

**Extraction** (`DocGen4/Process/DepGraph.lean`, hooked into `Process.process`):
for every rendered declaration, the used constants of its *type* and of its
*value* are collected separately and collapsed to human-facing declarations —
references to match auxiliaries, equation lemmas, `_proof_N`, private helpers
are transitively replaced by their own dependencies; constructors, projections
(field and parent), recursors and `noConfusion` are attributed to their parent
type. For inductives/structures the constructor signatures count as part of the
type. Each record also notes whether the value is a proof (`theorem` or
`Prop`-valued). Stored in two DB tables (`dep_nodes`, `dep_edges`). A failure on
one declaration (including a heartbeat timeout) costs only that declaration's
record and prints a warning. Extraction is skipped by `genCore` (no view uses
dependencies of core) and whenever `DOCGEN_DEPGRAPH=0`.

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
value-deps of proofs are dropped as pure noise). `fromDb` also emits
`declarations/header-data.bmp` (signature HTML per declaration) which the
panels render from. Both steps are best-effort: a failure prints a warning and
the views show that the data is unavailable, but the docs build succeeds.

**Views** (all client-side, `static/depgraph*.js`, `static/atlas.js`):

* every declaration page: a `deps` toggle (statement closure: everything the
  statement's meaning rests on, one readable list in dependency order, with
  signatures and source links, instances collapsed, external frontier as chips)
  and a `used by` toggle (blast radius: meaning-dependents counted and grouped
  into module prefix clusters — reads as "the X and Y stuff, not the Z stuff" —
  plus the count of proof-only dependents).
* `atlas.html` (navbar: "dependency atlas"): *core* (declarations ranked by
  meaning mass = how many statements transitively rest on them), *map*
  (force-directed module map, deterministic precomputed layout, cluster or
  per-module granularity, nodes colored by name-prefix cluster), *module
  matrix* (module × module DSM in topological order, canvas, click for the
  crossing references), *declaration* (search + closure DAG + both panels;
  deep-linkable via `atlas.html#decl=Name`).

`header-data.bmp` is minified JSON that compresses about twentyfold and can
exceed a host's per-file size limit for large projects. The panels first fetch
`declarations/header-data.bmp.gz` (decompressed in the browser) and fall back to
the plain file, so a deployment may gzip it and delete the original.

Known rough edges: names renamed/removed on Mathlib master render as unlinked
chips (same version-skew as HTML links); mutual definitions form 2-cycles that
mass ranking tolerates but does not condense.

**Cost.** Extraction adds to `ingest` time in proportion to the size of the
proof terms: negligible for most projects, but it nearly doubled the ingest time
of the most proof-term-heavy project measured (about 61 s without extraction,
111 s with it). `DOCGEN_DEPGRAPH=0` disables it. The likely costs, in
`DocGen4/Process/DepGraph.lean`, are `Expr.getUsedConstants` over every type and
value (each call materialising a fresh array), the first expansion of large
internal helpers (memoised per name afterwards), a `Meta.isProp` call per
declaration, and a pass that runs sequentially over modules. Possible speed-ups:
deduplicate while folding (`getUsedConstantsAsSet`) instead of materialising
arrays; skip `isProp` where the kind already decides it (`thmInfo`); since only
local proof dependencies are kept at emission, resolve and filter during the
traversal of theorem values to avoid most of the Mathlib-internal expansion; and
extract modules in parallel with a shared or merged memo.

Dev gotcha: the JS/CSS in `static/` is embedded into the binary via
`include_str`, and Lake does **not** track those files as module inputs. After
editing `static/`, force a rebuild of the embedding module:
`find .lake/build -name "Base.*" -path "*Output*" -delete && lake build doc-gen4`
(from a docbuild dir), or `lake clean` the package.

## Usage

The fork is driven directly through its `ingest` and `fromDb` commands rather
than through the `<Lib>:docs` Lake facet (which would populate a database with
the whole import closure, Mathlib included). A build has four steps.

1. **A nested docbuild project.** As in the upstream instructions in `README.md`,
   create `docbuild/lakefile.toml` in the project, requiring the project by path
   and this fork by git, with `packagesDir = "../.lake/packages"` so that the
   project's already-built packages (Mathlib included) are reused:

   ```toml
   name = "docbuild"
   reservoir = false
   version = "0.1.0"
   packagesDir = "../.lake/packages"
   defaultTargets = []

   [[require]]
   name = "MyProject"
   path = "../"

   [[require]]
   name = "doc-gen4"
   git = "https://github.com/timaeus-research/doc-gen4"
   rev = "timaeus/v4.33.1"   # the branch, or a commit on it, matching the project's toolchain

   # Mathlib last, so that its transitive pins win; keep in sync with the project's pin.
   [[require]]
   name = "mathlib"
   scope = "leanprover-community"
   rev = "v4.33.1"
   ```

   Build the project itself first (`lake build` in the project root), then run
   `lake update doc-gen4` in `docbuild/`.

2. **The address book.** Fetch Mathlib's published declaration index and flatten
   it to the `name\tdocLink` TSV that `DOCGEN_EXTERNAL_DECL_DATA` reads:

   ```python
   import json, urllib.request
   base = "https://leanprover-community.github.io/mathlib4_docs/"
   with urllib.request.urlopen(base + "declarations/declaration-data.bmp") as r:
       decls = json.load(r)["declarations"]
   with open("decl.tsv", "w", encoding="utf-8") as f:
       for name, info in decls.items():
           if link := info.get("docLink"):
               f.write(f"{name}\t{link}\n")
   ```

3. **Ingest the project's modules** into a fresh database, from `docbuild/`
   (`lake exe` runs the fork in the docbuild workspace, so the project's oleans
   are on `LEAN_PATH`):

   ```sh
   lake exe doc-gen4 ingest --build .lake/build \
     --source-base https://github.com/OWNER/REPO/blob/main/ \
     "$PWD/work.db" MyProject MyProject.Foo MyProject.Bar ...
   ```

4. **Emit the trimmed site**, also from `docbuild/`:

   ```sh
   DOCGEN_LOCAL_ROOTS=MyProject \
   DOCGEN_EXTERNAL_BASE=https://leanprover-community.github.io/mathlib4_docs/ \
   DOCGEN_EXTERNAL_DECL_DATA="$PWD/decl.tsv" \
   lake exe doc-gen4 fromDb --build "$PWD/emit" --manifest "$PWD/emit/manifest.json" \
     "$PWD/work.db" MyProject MyProject.Foo MyProject.Bar ...
   ```

   The site is in `emit/doc/`. Its links are relative, so it can be served from
   any path; optionally gzip `declarations/header-data.bmp` as described above.

Two points about choosing the module list:

- List **every module** of the library, not just the root aggregator: the
  `<Lib>:docs` facet documents only what `<Lib>.lean` imports, so modules that the
  aggregator does not import would otherwise be missing. Enumerating the source
  files (or the built `.olean`s) covers them.
- When a local dependency is only partially built, restrict the list to modules
  with a built `.olean`. The built set is closed under imports, so no dead links
  result.

On a Mathlib downstream of about seventy modules this produces about eighty
pages and 4 MB, with a search index of the local declarations only; Mathlib
links resolve on the live site with their anchors.
