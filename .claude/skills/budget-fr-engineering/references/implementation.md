# Mode Implémentation

Use this mode only for changes explicitly authorized by the user. Do not infer
permission to migrate, commit, push, or expand to another Budget FR phase.

## Select documents

Read the smallest authoritative set for the feature:

- the accepted ADR governing persistence, migration, or sync;
- the relevant business rules and acceptance criteria in
  `docs/budget-fr/functional-spec.md`;
- the relevant phase and boundaries in `docs/budget-fr/architecture.md`;
- the necessary technical paths in `docs/budget-fr/actual-baseline.md`.

Do not reread unrelated ADRs or product sections. Use a supplied sanitized
`Budget_famille` dataset as the expected behavior for acceptance tests, not as
code to translate mechanically.

## Before production code

1. Confirm the working tree and isolate the authorized files from unrelated
   user changes.
2. Restate the accepted data states, priority rules, and compatibility policy.
3. Locate the current symbols and tests; do not implement from documentation
   assumptions alone.
4. Write or define failing tests for the requested behavior before the business
   implementation. Include edge, reset, import, and persistence cases.
5. Stop if the change needs a persistence or sync decision not covered by an
   accepted ADR.

## Impact checklist

For every relevant item, either change and test it or document why it is not
affected:

- TypeScript entity and physical DB types;
- SQLite migration, old-file opening, backup, and repeat opening;
- AQL schema, field conversion, generated views, filters, and subscriptions;
- CRDT write/apply behavior, same-version multi-client sync, concurrency, and
  the accepted mixed-version policy;
- manual entry, CSV/QIF/OFX/CAMT imports, reimport, and reconciliation;
- split creation/editing/conversion and transfer counterpart propagation;
- rule priority and provenance;
- budget aggregation versus cash balance and forecast use of the bank date;
- public API input/output compatibility;
- desktop and mobile display, editing, filtering, sorting, and accessibility.

## Implementation rules

- Centralize domain transitions so related persistence fields change together.
- Preserve manual overrides across imports and automatic rules.
- Keep financial operations deterministic, integer-safe, and explainable.
- Prefer additive, forward migrations that preserve existing SQLite files. Do
  not backfill when the accepted model uses `null` as meaningful default state.
- Use Actual's existing AQL, mutation, tombstone, and CRDT mechanisms rather
  than parallel storage paths unless the ADR requires otherwise.
- Preserve upstream naming, module boundaries, and UI patterns where they do
  not conflict with the accepted Budget FR decision.
- Do not change `SYNC_FORMAT_VERSION` or treat `messages_crdt` as audit.

## Verification and handoff

Run the narrow unit/integration tests while iterating. Before handoff, run the
repository lint and typecheck plus the appropriate unit, API, sync, migration,
and UI tests for the changed surface. Run broader tests in proportion to risk
and repository instructions.

Inspect the final diff for generated files, personal data, unrelated changes,
and changes under unapproved packages. Report commands and exact outcomes,
including cache use or skipped checks. Present remaining migration, sync, and
product risks before any commit. Commit or push only after a separate explicit
request.
