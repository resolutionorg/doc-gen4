Dep-atlas extraction has made `tide-docs` seabed builds noticeably slower.

**Measured so far**

- Pre-atlas (reported by Billy): 12–60 s per seabed; the largest (tms or watanabe-examples) was ≈61 s.
- With the atlas (main@5206963, same machine, idle, 2026-07-02, from sequential-run `.tide-build.json` timestamps): most seabeds 10–45 s; suscep 33 s; pas/watanabe-examples ≈45 s; **tms ≈111 s**. A 12-seabed sweep is ≈4 min.
- A/B with `DOCGEN_DEPGRAPH=0`: suscep 31 s vs 32 s (extraction ≈0); tms 61 s vs 111 s (+82%) — the 61 s baseline matches the pre-atlas maximum, so the regression is entirely the extraction pass and concentrated in proof-term-heavy repos.

The added work happens in `Process.process` after analysis (`DocGen4/Process/DepGraph.lean`):

- `Expr.getUsedConstants` over every rendered declaration's type **and** value — proof terms are presumably the bulk (decide-heavy pas, large tms terms), and each call materializes a fresh array.
- `resolve`/`expandThrough` walking through internal helpers (match auxiliaries, `_proof_N`, private lemmas) traverses their full bodies; memoized per name, but the first touch of a large Mathlib-internal proof is expensive.
- `Meta.isProp` per declaration.
- The whole pass is sequential, one module at a time.

**Suggested attack**

1. Quantify first: time `ingest` on a large seabed with `DOCGEN_DEPGRAPH=0` vs `=1` (the opt-out already exists) to separate extraction cost from baseline analysis, then profile which of the above dominates.
2. Cheap wins: `getUsedConstantsAsSet` / fold-with-dedup instead of array materialization; skip `isProp` where the answer is already known (`thmInfo`).
3. For theorem values we only ever keep **local** proof-dep targets (external ones are dropped at emit) — a fold that resolves-and-filters during traversal could skip most of the Mathlib-internal expansion.
4. Parallelize extraction across modules (the memo would need to be shared or merged).

**Workaround** meanwhile: `DOCGEN_DEPGRAPH=0` disables extraction entirely.
