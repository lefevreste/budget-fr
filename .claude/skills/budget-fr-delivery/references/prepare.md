# Mode prepare

Use this mode to establish whether a Budget FR change is ready to deliver. It is
read-only except for test/build artifacts normally produced by required checks.
Do not stage, commit, push, create a PR, merge, or deploy.

## Repository and instructions

1. Run `scripts/check-delivery-context.sh` from the repository.
2. Identify the applicable `AGENTS.md` files for every changed path. Also load
   any skill required by the change type, such as Budget FR engineering, docs,
   VRT, release-note, or commit/PR instructions.
3. Record the branch, HEAD, upstream comparison, staged changes, unstaged
   changes, and untracked files. Preserve unrelated user work.
4. Refuse to continue on `master`, detached HEAD, wrong remotes, unresolved
   conflicts, or an unclear delivery scope.

Treat these remote identities as exact after URL normalization:

- `origin` fetch and push: `lefevreste/budget-fr`;
- `upstream` fetch and push configuration: `actualbudget/actual`.

Never mutate remotes silently. A mismatch is a blocker to report, not permission
to rewrite Git configuration.

## Diff review

Inspect both `git diff` and `git diff --cached`, plus untracked files in scope.
Summarize:

- objective and user-visible behavior;
- files and packages changed;
- migrations, SQLite, AQL, CRDT, imports, API, UI, and docs impacts where
  relevant;
- generated artifacts, secrets, personal data, or unrelated changes;
- accepted ADR and acceptance-criteria conformance;
- rollback approach and residual risks.

Do not call a change ready based only on a clean formatter or typecheck.

## Required controls

Derive the gate set from the user request, applicable instructions, affected
packages, and risk. Run focused checks first, then repository-level gates that
the change requires. Budget FR delivery normally requires at least:

- targeted tests for changed behavior;
- `yarn lint`;
- `yarn typecheck`;
- appropriate unit, API, migration, sync, UI, E2E, or VRT tests.

If any required lint, typecheck, or test fails, stop delivery. Report the exact
command, failure, and whether it appears pre-existing; do not weaken or relabel
the gate. A skipped or cached check must be identified as such.

## Proposal

Present the exact delivery diff and a conventional commit proposal based on the
actual scope, for example `feat(budget-fr): add budget period persistence`.
Apply any stricter repository commit rules discovered in the applicable
instructions.

Also prepare a PR summary for the user containing:

- objective;
- changes;
- tests and results;
- risks;
- rollback.

End by asking for explicit authorization for the intended next operations, such
as commit only or commit + push + fork PR. Do not treat approval of code changes
as approval to deliver them.
