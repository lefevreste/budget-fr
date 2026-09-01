# Mode Revue / validation

Use this mode for read-only assessment of a diff, implementation, migration,
ADR conformance, or readiness gate. Do not fix findings unless the user asks for
changes.

## Select documents

Derive the review contract from:

- the accepted ADRs directly touched by the diff;
- the relevant acceptance criteria and invariants in
  `docs/budget-fr/functional-spec.md`;
- the architecture phase or boundary affected by the change;
- `docs/budget-fr/actual-baseline.md` only when current Actual paths or known
  extension points need confirmation.

If sanitized `Budget_famille` acceptance data is available, compare observable
results with the workbook oracle. Do not send or copy personal financial data
outside the authorized workspace.

## Review method

1. Identify the exact diff, base revision, dirty-tree context, and claimed
   behavior.
2. Trace changed inputs through persistence, synchronization, calculations,
   API, and UI. Inspect callers and consumers, not only the edited file.
3. Check ADR conformance and upstream compatibility before style preferences.
4. Review tests for behavior and failure modes; do not accept tests that only
   mirror implementation details.
5. Run safe focused checks, then the repository lint, typecheck, and appropriate
   tests when requested or needed to substantiate the result.
6. Report findings first, ordered by severity, with file/symbol evidence and a
   concrete failure scenario. State when no finding was identified.

## Required review dimensions

- Bank date is never rewritten to obtain a budget result.
- Budget calculations use the effective budget period while cash and forecast
  calculations retain the bank date.
- Deterministic financial calculations do not depend on an LLM or binary
  floating-point additions introduced by the change.
- Manual assignments outrank rules and default behavior, including after
  import, reimport, reconciliation, or date changes.
- Splits and transfer counterparts obey the accepted MVP propagation rules.
- SQLite migration order, old-file behavior, AQL conversion/views, and backup
  implications are covered.
- CRDT messages preserve the intended states for supported clients; mixed
  versions follow the accepted policy. `SYNC_FORMAT_VERSION` is unchanged
  unless a dedicated accepted ADR authorizes it.
- Provenance is not overstated as a full business audit log, and
  `messages_crdt` is not used as one.
- API additions remain compatible and UI behavior is editable, filterable,
  accessible, and consistent where required.
- Tests cover acceptance cases, invalid states, reset paths, sync, migration,
  imports, splits, transfers, and the separation of budget from treasury.

## Handoff

Summarize the reviewed diff, checks run, failures or skips, and residual risks.
Distinguish confirmed facts from inferences. A green lint/typecheck alone does
not validate migration safety, CRDT behavior, or financial correctness. Do not
commit, push, approve externally, or modify the working tree without explicit
authorization.
