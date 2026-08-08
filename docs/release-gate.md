# Release benchmark gate

The A–D gate is deliberately separate from the deterministic context/review
proofs. It consumes a matrix produced by the real host benchmark and fails
closed when any quality, freshness, token, latency, schema, or regression
measurement is missing.

Run it after the benchmark matrix has been collected:

```powershell
node dist/cli.js benchmark release-gate --report .\benchmark-results\release-matrix.json --format markdown
```

The report must contain `arms.A`, `arms.B`, `arms.C`, and `arms.D`; each arm
needs `freshModelInputTokens`, `wallTimeMs`, `expectedFileRecall`,
`expectedMethodRecall`, `criticalMisses`, and `falseAnswerableCount`. The root
also needs `staleDetectionRate`, `advertisedSchemaTokenIncrease`,
`indexRegressionPercent`, and `queryRegressionPercent`.

The command prints `recommendation: enforce` only when every threshold in the
implementation plan passes. Otherwise it exits non-zero and recommends
`shadow`; it never changes `CODEGRAPH_RELEVANCE_GATE` itself. This keeps a
synthetic scale run (which proves indexing capacity, not semantic quality)
from being mistaken for a release decision.
