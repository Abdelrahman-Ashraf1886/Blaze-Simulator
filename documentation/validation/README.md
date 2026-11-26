# Validation

[Open the inventory](inventory.md#validation-inventory) for model equations and source locators, test evidence, measured errors, ranges, limitations and follow-up checks. This is the inventory half of milestone 8.7. The generated report and in-app page belong to the later report work. [phase-8-quality.md:78](../plans/phase-8-quality.md#L78) [phase-8-quality.md:85](../plans/phase-8-quality.md#L85)

Each row gives one verdict for the specific behavior it covers.

- **analytical** uses a closed-form result, hand calculation or derived statistical expectation.
- **published data** compares against a published value or table. The row says whether it was used to fit the model and whether the source data were computed or measured.
- **independent reference** checks against a separate implementation of the same calculation.
- **self-consistency only** checks local behavior, shared fixtures, same-engine expectations, regressions or round trips.
- **not validated** means an acceptance check for the behavior was not found. A diagnostic can still provide evidence of a defect.

The inventory records assertions found in test source and distinguishes tolerances from observed errors. Repository links and quoted test names were checked against the source. Test execution was outside this inventory pass. Test 10 requires fresh execution evidence in the generated report. No comparison with a real flight was found. [phase-8-quality.md:60](../plans/phase-8-quality.md#L60) [phase-8-quality.md:106](../plans/phase-8-quality.md#L106)
