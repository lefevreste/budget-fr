# Mode verify

Use this mode for read-only verification of an existing Budget FR pull request
and its CI. Do not commit fixes, push, rerun external jobs, merge, or deploy
without a new explicit request.

## Verify identity and scope

1. Confirm the local remotes still map to `origin = lefevreste/budget-fr` and
   `upstream = actualbudget/actual`.
2. Read back PR metadata. Require repository `lefevreste/budget-fr`, base
   `master`, and the expected fork feature branch as head.
3. Reject verification as a valid Budget FR delivery if the PR belongs to or
   targets `actualbudget/actual`.
4. Compare the PR commits and complete diff with the prepared scope. Identify
   unexpected files, generated data, migrations, or unrelated commits.

## Verify quality

- Check every required CI job and its current conclusion, not only aggregate
  success.
- Correlate CI jobs with the controls claimed in the PR summary and applicable
  instructions.
- Inspect logs for failed, cancelled, timed-out, neutral, or skipped required
  jobs. Do not report them as passing.
- Reassess Budget FR architecture, SQLite, sync, import, split, transfer, API,
  UI, privacy, and rollback risks when relevant to the diff.
- If local reproduction is needed, run safe focused checks followed by the
  required lint, typecheck, and tests. Keep local and CI evidence distinct.

Any required lint, typecheck, test, or CI failure stops the delivery gate. State
the precise blocker and the next authorized action; do not silently rerun,
patch, or waive it.

## Report

Produce a PR verification summary with:

- objective;
- changes actually present;
- local and CI tests with exact results;
- findings and residual risks;
- rollback path;
- verdict: ready, not ready, or blocked.

Never merge automatically. Deployment remains out of scope until a target is
documented and the user gives separate explicit authorization.
