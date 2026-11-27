# Validation report

[Open the generated report](report.md) for the results from the recorded build. The summary counts each model once. Area headings flag self-consistency and unvalidated models before the individual entries. [Phase 8, D11(a) and test 10](../plans/phase-8-quality.md#L62)

- **Analytical** compares against equations or hand calculations. **Published data** compares against a cited table or test vector and may include an in-sample fit. **Independent reference** compares against a separate implementation within the stated fixture.
- **Self-consistency only** covers behavior such as model-to-model agreement, deterministic replay, and simulator-defined acceptance. **Not validated** identifies a gap in the evidence. The flat-box rebound diagnostic records the K4 shortfall without an independent acceptance criterion. [K4 investigation](k4-rebound.md)
- **Result this run** gives numeric observations when a check emits them. A passing assertion with no emitted residual establishes the cited bound or exact predicate. Range and limits describe the scope of the comparison. See the [inventory](inventory.md) for open gaps and the basis for the verdicts.
- **Not compared with a real flight.** [Phase 8, D11(a)](../plans/phase-8-quality.md#L62)

## Regenerate

From the repository root, run with installed Node dependencies and a populated local Cargo cache.

```sh
npm run validation-report
```

The generator builds the release engine offline with one Cargo build job, reads the engine version from its hello response, runs the engine-core unit checks and the K4 diagnostic, then runs the inventory’s Vitest checks and the observation tests. The replay end-to-end link is a source citation. The report is written after the referenced tests and observation adapters pass. The command prints the elapsed time. [Generator](../../scripts/validation-report.mjs) · [Observation tests](../../tests/validation/observations.test.ts)

Compare repeated reports after excluding the build commit, engine version, machine and generation timestamp. Test durations and transient performance logs are excluded. To update coverage, edit the [inventory](inventory.md) and the matching [equations](equations.tsv), then regenerate. If an observation’s source log changes, update its adapter alongside the evidence it reads.
