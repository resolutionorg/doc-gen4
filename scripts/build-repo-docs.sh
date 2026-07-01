#!/usr/bin/env bash
# Build trimmed doc-gen4 docs for one timaeus Lean repo using the shared base DB.
#
# Emits HTML + a search index for the repo's OWN modules only; links to Mathlib
# and Lean core are redirected to the hosted docs (DOCGEN_EXTERNAL_BASE). The
# expensive Mathlib `docInfo` pass is paid once into a shared SQLite DB and
# reused across repos (the DB is additive, keyed by module name).
#
# Usage:
#   build-repo-docs.sh <repo-dir> <local-roots> [external-base]
# Example:
#   build-repo-docs.sh ../laplace "Laplace,Common,Threepoint"
#
# Output: <repo-dir>/docbuild/.lake/build/doc/   (copy to therisensea/docs/<repo>/)
set -euo pipefail

REPO_DIR="$(cd "${1:?repo dir}" && pwd)"
LOCAL_ROOTS="${2:?comma-separated local module roots, e.g. Laplace,Common,Threepoint}"
EXTERNAL_BASE="${3:-https://leanprover-community.github.io/mathlib4_docs/}"
FORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DOCBUILD="$REPO_DIR/docbuild"
LIB_NAME="$(grep -A1 '\[\[lean_lib\]\]' "$REPO_DIR/lakefile.toml" | grep 'name' | head -1 | sed 's/.*"\(.*\)".*/\1/')"
echo ">> repo=$REPO_DIR lib=$LIB_NAME roots=$LOCAL_ROOTS"

# 1. Scaffold docbuild/ if absent (reuses the repo's already-built ../.lake/packages).
if [[ ! -f "$DOCBUILD/lakefile.toml" ]]; then
  echo ">> scaffolding $DOCBUILD"
  mkdir -p "$DOCBUILD"
  cp "$REPO_DIR/lean-toolchain" "$DOCBUILD/lean-toolchain"
  PKG_NAME="$(grep '^name' "$REPO_DIR/lakefile.toml" | head -1 | sed 's/.*"\(.*\)".*/\1/')"
  cat > "$DOCBUILD/lakefile.toml" <<EOF
name = "docbuild"
reservoir = false
version = "0.1.0"
packagesDir = "../.lake/packages"
defaultTargets = []
[[require]]
name = "$PKG_NAME"
path = "../"
[[require]]
name = "doc-gen4"
path = "$FORK_DIR"
# mathlib LAST so its transitive dep pins win, keeping the shared build valid.
[[require]]
name = "mathlib"
scope = "leanprover-community"
rev = "v4.29.0"
EOF
  ( cd "$DOCBUILD" && lake update doc-gen4 )
fi

cd "$DOCBUILD"
BUILD="$PWD/.lake/build"
DB="$BUILD/api-docs.db"

# 2. Build the doc-gen4 fork executable.
lake build doc-gen4

# 3. Populate the DB. Build docInfo for EVERY source module of the lib (the lib
#    docInfo facet only covers root-reachable modules, so we enumerate all of
#    them — this also picks up modules not imported by the lib root aggregator).
mapfile -t MODS < <(cd "$REPO_DIR" && find "$LIB_NAME" -name '*.lean' | sed 's|/|.|g; s|\.lean$||' | sort)
echo ">> ${#MODS[@]} modules; building docInfo (Mathlib docInfo reused from shared DB if present)"
lake build "${MODS[@]/%/:docInfo}"

# 4. Emit HTML + search index for local roots only; redirect the rest.
EXE="$(find "$FORK_DIR/.lake" -name doc-gen4 -type f -perm +111 | head -1)"
export DOCGEN_LOCAL_ROOTS="$LOCAL_ROOTS"
export DOCGEN_EXTERNAL_BASE="$EXTERNAL_BASE"
echo ">> emitting docs (local roots: $LOCAL_ROOTS -> local; everything else -> $EXTERNAL_BASE)"
"$EXE" fromDb --build "$BUILD" --manifest "$BUILD/doc-manifest.json" "$DB" "${MODS[@]}" Lean Init Std Lake

echo ">> done: $BUILD/doc"
echo ">>   files: $(find "$BUILD/doc" -type f | wc -l | tr -d ' '), size: $(du -sh "$BUILD/doc" | cut -f1)"
echo ">>   deploy: cp -r '$BUILD/doc/.' 'therisensea/docs/<repo>/'"
