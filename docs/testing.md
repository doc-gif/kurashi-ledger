# Test strategy

Product tests are not implemented yet. T02 added tests for the development tooling only (`npm test`: the install record and `npm run setup`, the publication check, and the pinned Node.js runtime; see docs/development.md). The review tool has its own tests (see tools/review_guard/README.md). Earlier local bootstrap experiments were inventoried in T02 and were not adopted as-is.

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

## Rules

Before adopting a calculator, record official source examples and independently reviewed expected values. Test boundary equality, dates, age transitions, rounding, multiple employers and mid-year changes. Record the jurisdiction and rule version for each fixture.

Include deliberate mutations such as changing `<` to `<=` or moving a rounding step, and verify that tests detect them. Do not assume that earning more always increases net income.

Use synthetic fixtures in public tests. Do not anonymize private documents merely by removing the name: employer, dates and precise amounts can also identify someone.

Planned CI (T05) will install with `npm run setup` and run type checking, tests and publication checks on standard Ubuntu, Windows and macOS runners. It is not configured yet. Real data must never enter CI or uploaded artifacts.
