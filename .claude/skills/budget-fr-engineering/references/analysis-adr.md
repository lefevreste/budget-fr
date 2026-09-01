# Mode Analyse / ADR

Use this mode to understand the current system, compare designs, or record a
decision. Do not implement the feature unless the user separately authorizes
implementation.

## Select documents

After reading repository instructions, load only the documents that answer the
current question:

- `docs/budget-fr/functional-spec.md` for business rules, invariants, acceptance
  criteria, and MVP boundaries;
- `docs/budget-fr/architecture.md` for phases, system boundaries, target model,
  and mandatory ADRs;
- `docs/budget-fr/actual-baseline.md` for the observed Actual Budget transaction,
  SQLite, AQL, rule, sync, API, and UI paths;
- the accepted ADRs under `docs/budget-fr/adr/` that govern the decision;
- `docs/budget-fr/FIRST-CODEX-TASK.md` only when reproducing or revising the
  baseline mission.

If a `Budget_famille` workbook or extracted acceptance dataset is supplied,
inspect the relevant sheets, formulas, inputs, and expected outputs. Treat
those observed results as the functional oracle while keeping the calculation
implementation independent and deterministic. Use sanitized fixtures; do not
commit real household data.

## Procedure

1. State the decision or diagnostic question and the non-negotiable business
   invariants.
2. Trace the existing code and data path before proposing a design. Cite files
   and symbols, and distinguish observed behavior from inference.
3. Cover every affected layer: SQLite schema and migrations, AQL types/views,
   CRDT messages and version compatibility, imports/reimports, split and
   transfer propagation, API contracts, UI editing/filtering, and relevant
   budget or forecast consumers.
4. Compare viable options with migration, compatibility, query, maintenance,
   backup, rollback, and upstream-delta consequences.
5. Record structural choices in an ADR with context, decision, data model,
   invariants, consequences, migration, sync, rejected alternatives, risks,
   implementation gate, and required tests.
6. Mark the ADR accepted only when the requested decisions are explicit and no
   unresolved choice would materially change persistence or compatibility.

## Architecture boundaries

- Preserve the bank fact: cash balances and treasury forecasts use the bank
  date. Budget aggregations use the effective budget period.
- Monetary values stay in Actual's integer minor-unit convention unless an
  accepted ADR defines another contract.
- A nullable or derived field needs explicit semantics at SQLite, AQL, API, and
  UI boundaries.
- Treat CRDT messages as per-cell synchronization state, not an atomic domain
  object or audit trail. Analyze concurrency and mixed-client versions.
- Do not propose a `SYNC_FORMAT_VERSION` bump as a routine schema migration.

## Output

Conclude with the recommendation, unresolved uncertainties, risk levels, exact
files likely affected, tests required before code, and a clear implementation
readiness decision. A missing ADR, ambiguous sync behavior, or unsafe SQLite
migration makes readiness `NO`.
