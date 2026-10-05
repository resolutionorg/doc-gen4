# `doc-gen4` (Timaeus fork)
Document Generator for Lean 4

> **This is a fork of [`leanprover/doc-gen4`](https://github.com/leanprover/doc-gen4), based at tag `v4.33.1` (upstream commit `e2af49a`; originally forked at `v4.29.0`).**
> It lets a Mathlib-importing project publish documentation for its own modules
> only, with references to Mathlib and core linked out to the hosted Mathlib
> documentation (no local Mathlib database), and it adds declaration-level
> dependency views to the generated pages.
> Branches are named `timaeus/v4.<x>.<y>` after the upstream tag they are based on;
> use the branch matching your project's Lean toolchain.

## Changes relative to upstream

See [`TIMAEUS.md`](TIMAEUS.md) for the design, the rationale, the known
limitations and a complete build recipe. In brief:

- **`DOCGEN_LOCAL_ROOTS`** (comma-separated module roots, e.g. `MyProject,MyProjectExamples`) —
  `fromDb` emits HTML **and** the search index only for modules whose root is in
  this allowlist. The full DB linking context is still loaded, so cross-references
  resolve. This trims a Mathlib downstream from hundreds of thousands of files
  down to just the project's own modules. (`Main.lean`, `DocGen4/Output.lean`)
- **`DOCGEN_EXTERNAL_BASE`** (e.g. `https://leanprover-community.github.io/mathlib4_docs/`) —
  `moduleNameToLink` redirects links for modules outside `DOCGEN_LOCAL_ROOTS` to
  this base instead of a local relative path, keeping Mathlib/core references
  clickable against the already-hosted docs. (`DocGen4/Output/Base.lean`)
- **`DOCGEN_EXTERNAL_DECL_DATA`** (path to a hosted `declaration-data.bmp`, as downloaded) — a declaration
  reference not found in the local database is resolved from this **address
  book** (built from Mathlib's own published `declaration-data.bmp`). This is
  what lets the emitted database contain **only the project's own modules** —
  there is no Mathlib in any database. (`DocGen4/Output/Base.lean`, `DocGen4/Output.lean`)
- **`ingest` command** — adds many modules to a database in a single environment
  load (one `importModules`), each with its own source URL derived from
  `--source-base`. Used to ingest a project's own modules into a fresh database.
  (`Main.lean`, `DocGen4/DB.lean`)
- **`docs` facets emit the trimmed site** — `lake build MyLib:docs` runs
  `ingest` over the local modules in the import closure of the library's roots
  and `fromDb` over them, without core; upstream's full build is `fullDocs`.
  The configuration is the environment of the `lake build` (the variables
  above). (`lakefile.lean`)
- **Dependency atlas** — every declaration page gets `deps` (statement closure)
  and `used by` (dependents) panels, and the site gets an `atlas.html` page with
  whole-library views. The data is extracted during analysis and written to
  `declarations/depgraph.json` and `declarations/header-data.bmp`;
  `DOCGEN_DEPGRAPH=0` skips the extraction. (`DocGen4/Process/DepGraph.lean`,
  `DocGen4/Output/DepGraph.lean`, `static/`)

With none of the three `DOCGEN_*` link variables set, the emitted pages and
links are those of upstream, with two exceptions: the dependency atlas is
added, and a few references that upstream would emit as dead links (such as
abbreviated `Path/To/Module.lean` mentions in docstrings) render as plain
text (see "Links" in `TIMAEUS.md`).
To move to a new upstream release: `git fetch upstream --tags`, create
`timaeus/v4.<x>.<y>` from the tag `v4.<x>.<y>`, and merge the previous fork
branch into it.

## Usage
`doc-gen4` is easiest to use via its custom Lake facet. The currently recommended setup for
this is that you create a nested project for documentation building inside of your lake project.
To do this:
1. Create a subdirectory within your existing lake project called `docbuild`
2. Create a `lakefile.toml` within `docbuild` with the following content:
```toml
name = "docbuild"
reservoir = false
version = "0.1.0"
packagesDir = "../.lake/packages"

[[require]]
scope = "leanprover"
name = "doc-gen4"
# If you are developing against a release candidate or a stable version `v4.x`, replace `main` below by `v4.x`.
# If you do not use `main` keep in mind to update this field as you update your Lean version.
rev = "main"

[[require]]
name = "Your Library Name"
path = "../"
```
3. Run `lake update doc-gen4` within `docbuild` to pin `doc-gen4` and its dependencies to the chosen versions.
   IMPORTANT: If you depend on [mathlib4](https://github.com/leanprover-community/mathlib4) run
   `MATHLIB_NO_CACHE_ON_UPDATE=1 lake update doc-gen4` instead to mitigate a small issue in
   mathlib's caching mechanism for now.
4. If your parent project has dependencies you want to run `lake update YourLibraryName` within
  `docbuild` whenever you update the dependencies of your parent project.

After this setup step you can generate documentation for an entire library and all files imported
by that library using the following command within `docbuild`:
```
lake build YourLibraryName:docs
```
If you have multiple libraries you want to generate full documentation for:
```
lake build Test:docs YourLibraryName:docs
```

Note that `doc-gen4` currently always generates documentation for `Lean`, `Init`, `Lake` and `Std`
in addition to the provided targets.

The root of the built docs will be `docbuild/.lake/build/doc/index.html`.
However, due to the "Same Origin Policy", the generated website will be partially broken if you just
open the generated html files in your browser.  You need to serve them from a proper http server for
it to work. An easy way to do that is to run `python3 -m http.server` from the `docbuild/.lake/build/doc`
directory.

## Requirements to run `doc-gen4`
In order to compile itself `doc-gen4` requires:
- a Lean 4 or `elan` installation
- a C compiler if on Linux or MacOS (on Windows it will use Lean's built-in clang compiler)

Apart from this the only requirement for `lake build YourLibraryName:docs` to work is that your
target library builds, that is `lake build YourLibraryName` exits without an error. If this requirement
is not fulfilled, the documentation generation will fail and you will end up with
partial build artefacts in `docbuild/.lake/build/doc`. Note that `doc-gen4` is perfectly capable of
generating documentation for Lean code that contains `sorry`, just not for code
that doesn't compile.

If you are working on a project that only partially compiles but can't fix the
errors from the top of your head, you can try to remove `import`s of both the failing files
and all files that refer to the failing ones from your top level library file.
Like this you will end up with an incomplete documentation but at least working
documentation of your project.

Note that we do not recommend this approach and suggest to instead make sure your
projects always compile by using CI to prevent broken code from being added and `sorry`-ing
out things that you intend to complete later.

## Source locations

Source locations default to guessing the GitHub repo for the library, but different schemas can be used by setting the `DOCGEN_SRC` environment variable.  For
example, one can use links that open the local source file in VSCode by running lake with:
```
DOCGEN_SRC="vscode" lake ...
```

The different options are:

 * `DOCGEN_SRC="github"` infers the
   GitHub project for each library and uses source links to the GitHub source view.
   This is the default if `DOCGEN_SRC` is unset.
 * `DOCGEN_SRC="file"` creates references to local file references.
 * `DOCGEN_SRC="vscode"` creates [VSCode URLs](https://code.visualstudio.com/docs/editor/command-line#_opening-vs-code-with-urls) to local files.

## Disabling equations
Generation of equations for definitions is enabled by default, but can be disabled by setting the `DISABLE_EQUATIONS` environment variable to `1`.

## How does `docs#Nat.add` from the Lean Zulip work?
If someone sends a message that contains `docs#Nat.add` on the Lean Zulip this will
automatically link to `Nat.add` from the `mathlib4` documentation. The way that this
feature is implemented is by linking to `/find` of generated documentation in the following way:
<https://example.com/path/to/docs/find/?pattern=Nat.add#doc> in the case of the `mathlib4`
documentation this ends up being to: <https://leanprover-community.github.io/mathlib4_docs/find/?pattern=Nat.add#doc>.
If you wish to provide a similar feature to `docs#Nat.add` from the Lean Zulip for your documentation,
this is the way to go.

## Development of doc-gen4
You can build docs using a modified `doc-gen4` as follows:  Replace the `doc-gen4` require from
docbuild with:
```
[[require]]
name = "doc-gen4"
path = "../../path/to/your/doc-gen4"
```

Note that if you modify the `.js` or `.css` files in `doc-gen4`, they won't necessarily be copied over when
you rebuild the documentation.  You can manually copy the changes to the `docbuild/.lake/build/doc` directory to make
sure the changes appear, or just do a full recompilation (`lake clean` and `lake build` inside the `doc-gen4`
directory.)
