# doc-gen4 (Timaeus fork)

Fork of [`leanprover/doc-gen4`](https://github.com/leanprover/doc-gen4) at tag
`v4.33.1` with two additions:

* **Trimmed sites.** A project on Mathlib documents its own modules only;
  references to Mathlib and core link out to the hosted `mathlib4_docs`.
  Upstream documents the whole import closure, which for a Mathlib downstream
  is hundreds of thousands of pages. [PR 396](https://github.com/leanprover/doc-gen4/pull/396)
  is the same idea.
* **Dependency atlas.** Declaration-level dependency views on every page and an
  `atlas.html` overview.
* **Non-incremental builds** this fork doesn't support building the doc incrmentally. It's faster for clean builds.

Branches are named `timaeus/v4.<x>.<y>` after the upstream tag they are based
on. Require the branch, or a commit on it, matching the project's toolchain.

## Usage

As with upstream, you are recommended to create a separate lean project (typically in a directory `docbuild/`)
 project requires the project by path and this fork by git, with `packagesDir = "../.lake/packages"` so Mathlib is shared. 

As with upstream, you may also need hacks like copying to `docbuild/docs/references.bib`, or running `LAKE_RESTORE_ARTIFACTS=true lake build`, depending on your project.

You then need to download `declaration-data.bmp`, the search index every doc-gen4 site publishes (about 68 MB for Mathlib), which maps each declaration of the hosted site to its page and anchor, so external references can be linked without a local Mathlib database; the fork reads it as downloaded. Then set environment variables. From `docbuild/`:

```sh
curl -sL -o decl-data.bmp \
  https://leanprover-community.github.io/mathlib4_docs/declarations/declaration-data.bmp
DOCGEN_LOCAL_ROOTS=MyProject,MyProjectExamples \
DOCGEN_EXTERNAL_BASE=https://leanprover-community.github.io/mathlib4_docs/ \
DOCGEN_EXTERNAL_DECL_DATA="$PWD/decl-data.bmp" \
DOCGEN_GZIP_HEADER_DATA=1 \
lake build MyProject:docs MyProjectExamples:docs
```

The site is output at  `.lake/build/doc/`.

The fork adds the following variables.

| Variable | Effect |
|---|---|
| `DOCGEN_LOCAL_ROOTS` | Top-level module names that are the site's own, comma-separated. Default: the library's roots. Set it when several libraries share a site. An imported module that is neither local nor on the hosted site is named without a link. |
| `DOCGEN_EXTERNAL_BASE` | Hosted site that links to other modules and declarations point at. Unset: no redirection. |
| `DOCGEN_EXTERNAL_DECL_DATA` | That site's `declaration-data.bmp`, for declaration links. Unset: external declarations are plain text. |
| `DOCGEN_GZIP_HEADER_DATA` | Ship `declarations/header-data.bmp.gz` instead of the plain file, which can exceed hosts' file limits. |
| `DOCGEN_DEPGRAPH` | `0` skips the atlas extraction. |

## How it works

**Facets.** `MyLib:docs` is overridden: it collects the import closure of the
library's roots, keeps the modules whose top-level name is in
`DOCGEN_LOCAL_ROOTS`, and runs `ingest` over them (one environment load per
source library, source links from the `srcUri` facets) into the shared
database, then `fromDb`. Core is not documented. Upstream's facets are kept as
`fullDocs`. (`lakefile.lean`)

**Commands.** `ingest DB MODULES...` adds modules to a database in one
environment load, with source links from `--source-base`; upstream's `single`
does one module per load. `fromDb` is upstream's, plus the trimming and
redirection below. (`Main.lean`)

**Links.** `fromDb` emits pages and search entries only for modules under the
local roots. A link to another module goes to `DOCGEN_EXTERNAL_BASE`; a
declaration not in the database is looked up in the address book,
`DOCGEN_EXTERNAL_DECL_DATA`, and linked to the hosted page. The database holds
only the project's modules; no Mathlib database is built or hosted. Three
upstream spots that assumed every target is in the database were adjusted so
external targets link out or render as text instead of dead links, and an
imported module that is neither local nor on the hosted site (per the address
book's module list) is named without a link. (`DocGen4/Output.lean`,
`DocGen4/Output/Base.lean`)

**Version skew.** The hosted `mathlib4_docs` tracks Mathlib master and keeps no
per-version archive, while a project pins a release. Links are resolved from the
same data they point at, so they are never broken, but a declaration renamed
since the pin renders as plain text, and one whose statement changed links to
master's version. Serving a snapshot of the hosted site from the pinned era and
pointing the two variables at it would close the gap; it has not been worth it.

**Dependency atlas.** During analysis, every rendered declaration's used
constants are collected for its type and its value separately and collapsed to
human-facing declarations (auxiliaries, equation lemmas and `_proof_N` expand to
their own dependencies; constructors, projections and recursors attribute to
their type). Stored in `dep_nodes` and `dep_edges`; a failure costs one
declaration. `fromDb` writes `declarations/depgraph.json` and the signatures in
`declarations/header-data.bmp`, and the client (`static/depgraph*.js`,
`static/atlas.js`) renders a `deps` panel (what a statement rests on) and a
`used by` panel (what depends on it) on each page, and `atlas.html` with ranked
declarations, a module map and a module matrix. The type/value split
distinguishes *meaning* edges (type, and value of definitions) from *proof*
edges, after Lean Atlas (arXiv:2604.16347). Extraction adds to `ingest` time in
proportion to proof-term size, up to about double. (`DocGen4/Process/DepGraph.lean`,
`DocGen4/Output/DepGraph.lean`)

## Development

* `static/` is embedded with `include_str`, which Lake does not track: after
  editing it, `find .lake/build -name "Base.*" -path "*Output*" -delete` before
  `lake build doc-gen4`, or `lake clean`.
* The database and emitted pages accumulate in the build directory across
  runs, as upstream; `lake clean` in `docbuild/` starts over.
* The atlas classifies references exactly within one `ingest` run and by
  name heuristics across runs, so libraries built by separate facets get
  slightly coarser cross-library edges.
