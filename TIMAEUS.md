# doc-gen4 (timaeus fork)

Fork of [`leanprover/doc-gen4`](https://github.com/leanprover/doc-gen4) at tag
`v4.29.0`, patched so that a Mathlib-importing project can publish docs for **its
own modules only** while still linking correctly to Mathlib/core declarations.

Upstream `lake build <Lib>:docs` emits one HTML page (plus source mirror and
per-module search shard) for **every module in the transitive import closure** —
for any Mathlib downstream that is the whole of Mathlib, ~hundreds of thousands
of files and a multi-GB search index. That blows past Cloudflare Pages limits
(20,000 files free / 100,000 paid, 25 MiB/file) and is wasteful when Mathlib
docs are already hosted.

## What the fork changes

Two env-var-gated behaviours; with neither set the fork is byte-identical to
upstream.

### `DOCGEN_LOCAL_ROOTS` — trim emitted modules + search index

Comma-separated list of top-level module roots considered "local"
(e.g. `Laplace,Common,Threepoint`). In `runFromDbCmd` (`Main.lean`), after the
transitive closure is computed, `targetModules` is filtered to modules whose
root is in this list. Because per-module HTML **and** the per-module
`declaration-data-*.bmp` search shard are only written for `targetModules`, and
`htmlOutputIndex` builds the unified search index by merging the shards on disk,
this single filter trims **both** the page count and the search index to just
the local project. The full DB linking context (`name2ModIdx`, `moduleNames`,
source URLs) is still loaded, so cross-references into Mathlib resolve.

### `DOCGEN_EXTERNAL_BASE` — redirect external links

Base URL (e.g. `https://leanprover-community.github.io/mathlib4_docs/`). In
`moduleNameToLink` (`Output/Base.lean`), any module whose root is **not** in
`localRoots` has its link rewritten to `<base>/Module/Path.html` instead of a
local relative path. doc-gen4's URL scheme (`Mathlib/Foo/Bar.html#decl.name`) is
identical to the hosted Mathlib docs, so declaration anchors carry over.
`declNameToLink` appends `#<decl>` on top, so external declaration links land on
the right anchor. Both fields live on `SiteBaseContext`, populated from the
environment in `getSimpleBaseContext` (`Output.lean`).

## Caveat: Mathlib version skew

The hosted `mathlib4_docs` tracks Mathlib **master**, while these repos pin
`v4.29.0`. Most stable declarations resolve, but renamed/moved/added decls will
404. For correct links, host a Mathlib doc set built from the **same** pin (see
"Self-hosted Mathlib" below) and point `DOCGEN_EXTERNAL_BASE` at it.

## Usage (per-project docbuild)

A sibling `docbuild/` project requires the target lib + this fork and reuses the
already-built Mathlib via a shared `packagesDir`:

```toml
# <repo>/docbuild/lakefile.toml
name = "docbuild"
reservoir = false
packagesDir = "../.lake/packages"
defaultTargets = []
[[require]]
name = "laplace"
path = "../"
[[require]]
name = "doc-gen4"
path = "../../doc-gen4-timaeus"
# mathlib LAST so its transitive dep pins (plausible, batteries) win
[[require]]
name = "mathlib"
scope = "leanprover-community"
rev = "v4.29.0"
```

Use `scripts/build-repo-docs.sh <repo-dir> <local-roots>` — it scaffolds
`docbuild/`, reuses the repo's already-built `../.lake/packages`, populates the
shared `api-docs.db`, and emits the trimmed site:

```bash
scripts/build-repo-docs.sh ../laplace "Laplace,Common,Threepoint"
# output: ../laplace/docbuild/.lake/build/doc/   (copy to therisensea/docs/laplace/)
```

Note it enumerates **all** of the lib's source modules as `fromDb` roots, not
just the lib's root aggregator. doc-gen4's `<Lib>:docs` facet only documents the
transitive closure of the root module (`Laplace.lean`); laplace had 16 modules
(a WIP Anharmonic-FDT cluster + covariance variants) not imported by it, which
that facet silently drops. Enumerating every `.lean` as a root covers them.

## Shared base DB (build Mathlib's docInfo once)

The `docInfo` pass over Mathlib's full transitive closure (~10.4k modules, ~54
min, ~700 MB `api-docs.db`) is the only expensive step. The DB is additive and
keyed by module name, so it is built **once** and reused: every timaeus repo
pins the same `v4.29.0` + Mathlib `v4.29.0`, so one shared DB serves them all.
Per repo only that repo's own modules are added, then `fromDb` emits its site.

## Verified result (laplace, v4.29.0)

- 68/68 Laplace source modules documented (incl. the 16 orphans), + Common, Threepoint.
- **95 files, 4.4 MB** total (vs all of Mathlib at hundreds of thousands of files).
- Search index: **615 local declarations, 86 KB**, zero Mathlib.
- 15/15 sampled Mathlib cross-reference links resolve on the hosted site, anchors intact.
- Self-contained relative links (`SITE_ROOT="./"`): deploys unchanged under
  `therisensea.org/docs/laplace/`.
</content>
