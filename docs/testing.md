# Test strategy

Product tests (the areas are listed under "製品の試験" in docs/project-status.md):

- Record domain (T06, `src/domain/records/*.test.ts`): unit tests for amount states, IDs, revisions, point-in-time views, supersede series, master canonical IDs and record-only aggregates, and a test that replays the T03 fixture ledger through the domain and compares outcomes and the T06-owned checks with the ledger's expected values (checks owned by T11 and T15 are listed as out of scope and matched against the ledger).

T02 added tests for the development tooling only (`npm test`: the install record and `npm run setup`, the publication check, and the pinned Node.js runtime; see docs/development.md). T05 added CI and the browser test base (Playwright; tests live in `e2e/*.spec.ts` and run with `npm run test:browser`). The review tool has its own tests (see tools/review_guard/README.md). Earlier local bootstrap experiments were inventoried in T02 and were not adopted as-is.

## Required acceptance cases as features are added

1. Bank-only receipt records cash but leaves salary and withholding unknown.
2. A later payroll statement links to the receipt without adding its net amount to salary again.
3. Import order does not change final reconciled totals.
4. Re-importing the same external record is idempotent, while different same-value payments remain possible.
5. Annual statements reconcile with monthly data rather than being added to them.
6. A previous-year statement does not affect current-year totals.
7. Work period and pay date can be in different months/years.
8. Unknown and zero survive persistence and CSV round trips distinctly.
9. Split/combined payments cannot be over-allocated.
10. Actuals replace only the associated part of a forecast.
11. Corrections preserve historical records and calculations.
12. Partial inputs produce explicit incomplete or provisional results.
13. UI rearrangement does not affect domain calculations.
14. Backups restore records, evidence, relationships and history in a clean environment.

T03 turned the contract examples (docs/contracts/examples.md) and these cases into a synthetic fixture ledger with expected results derived from the contract text, not from an implementation: `tests/fixtures/ledger/` (fixtures and the ledger check `ledger.test.ts`, which runs as part of `npm test` and in CI) and docs/test-oracles/README.md (how to read and use it, and open questions). Regime cases there must state the year, jurisdiction, primary sources and rounding before they can be approved.

## Rules

Before adopting a calculator, record official source examples and independently reviewed expected values. Test boundary equality, dates, age transitions, rounding, multiple employers and mid-year changes. Record the jurisdiction and rule version for each fixture.

Include deliberate mutations such as changing `<` to `<=` or moving a rounding step, and verify that tests detect them. Do not assume that earning more always increases net income.

Use synthetic fixtures in public tests. Do not anonymize private documents merely by removing the name: employer, dates and precise amounts can also identify someone.

CI (T05, `.github/workflows/ci.yml`) installs with `npm run setup` on the pinned Node.js range and runs type checking, `npm test`, the build check, the publication check, the review tool tests and the browser tests (Chromium on Ubuntu, Windows and macOS; WebKit on macOS) on standard GitHub-hosted runners. It compares the skipped tests on each OS with the table in docs/development.md and fails on unexpected skips, failures, cancellations or missing jobs. Node tests added as `*.test.ts` under `scripts/`, `src/` or `tests/`, and browser tests added as `e2e/*.spec.ts`, run on all three systems. A green run does not replace an independent review. CI uses synthetic data only and uploads no artifacts. Real data must never enter CI or uploaded artifacts.
