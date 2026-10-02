# Architecture decision 001: Small application, explicit boundaries

Status: accepted direction, confirmed by T00 (effective once the T00 ADRs are on main). T00 recorded the runtime, local HTTP boundary, UI, SQLite driver and data storage decisions in [docs/adr/](adr/README.md) (ADR-0002 to ADR-0006).

TypeScript is the language for records, input validation and application workflows, running on Node.js LTS (ADR-0002). Keep one application with modules; introduce additional runtimes only after a concrete evaluation.

## Boundaries

- `domain`: facts, amount states, reconciliation and pure calculations. No DB, HTTP, system clock or UI imports.
- `application`: record, correct, reconcile and simulate workflows. Dependencies are passed explicitly.
- `infrastructure`: implementations of storage, evidence files, clocks and external adapters. To be added as needed.
- `ui`: source-specific forms and replaceable dashboard. To be added as needed.
- `rules`: dated, sourced parameters and rule manifests. No unverified tax values at bootstrap.

Persistence interfaces should express use cases rather than duplicate every SQL table. Avoid a generic rule language and a DI container until they solve a concrete problem.

## Inputs and records

Support manual forms first. Future CSV, OCR and API inputs enter the same validation and draft-confirmation workflow.

Keep payroll statements, bank receipts, annual statements, forecasts and official notices as separate records. Associate them to explain the same economic event; never sum them simply because they came from different sources.

Company/month is a display grouping, not a unique identifier. Multiple payments, bonuses, corrections and split receipts must remain possible. Reconciliation can eventually allocate amounts across multiple statements and receipts.

Unknown, observed zero, not applicable and not stated are distinct. A partial year subtotal is not a confirmed annual total. Bank-only records allow cash tracking while salary and tax calculations remain incomplete.

Separate work periods, scheduled payment dates, observed bank dates and tax attribution. Do not infer work month from receipt month. Tax attribution requires a separately verified rule.

## History and calculations

Keep effective periods, recorded timestamps and, where known, when the user learned a fact. Corrections preserve old revisions.

A calculation run stores input snapshots, assumptions, rule version, engine version, results, rounding steps, source references and missing fields. New knowledge generates a new run.

Eligibility predictions and insurer-confirmed dates are different states. A forecast must not present an unconfirmed qualification-loss date as final.

## Portability and storage

CSV is a versioned interchange format, with IDs, dates, amount states and relationship references. It is not a complete backup.

Backups include DB, evidence, rules and version manifests; engine versions must remain obtainable. Acceptance requires restore into a clean environment. Encryption, destination and retention are defined in ADR-0006.

Actual user data, exports and backups belong outside this public checkout, in the data root defined by ADR-0006. The `.gitignore` and planned publication guard are additional protections, not the primary storage boundary.
