# Mode deliver

Use this mode only after `prepare` is green and the user explicitly approves
the exact delivery operations. Load the repository's commit/PR skill and rules
when available.

## Revalidate before mutation

1. Rerun `scripts/check-delivery-context.sh`.
2. Confirm branch, HEAD, remotes, working tree, and required check results still
   match the prepared state. Rerun stale checks when the diff changed.
3. Confirm the user's approval covers each intended operation: commit, push,
   and PR creation. Missing approval stops before that operation.
4. Stage only approved paths. Inspect and present `git diff --cached` before the
   commit. Never absorb unrelated work.

## Commit

- Use the approved conventional commit message and any applicable repository
  prefix or attribution rule.
- Do not amend, squash, rebase, reset, or force without separate explicit
  authorization.
- Read back the new commit hash, subject, and file list.
- If the commit hook or a required gate fails, stop. Do not bypass hooks.

## Push

- Push only to `origin` and only the approved feature branch.
- Never run `git push upstream` and never use a URL that bypasses the verified
  remote.
- Do not force-push by default. A force operation requires separate explicit
  authorization and a demonstrated safe target.
- Read back the remote branch state after pushing.

## Pull request

Create a PR only when explicitly approved and only with all of these properties:

- repository: `lefevreste/budget-fr`;
- base: `master`;
- head: the pushed feature branch from the fork;
- title and template behavior: compliant with the applicable repository
  commit/PR instructions.

Use an explicit repository target in the PR command or API call. Never infer the
target from `upstream`, and never create a PR in or toward
`actualbudget/actual`.

The handoff summary must contain objective, changes, tests, risks, and rollback.
If repository instructions require the PR template to remain untouched, present
this summary to the user separately instead of replacing or filling the PR
body.

After creation, read back the PR URL, repository owner/name, base, head, title,
and initial checks. A mismatch is a delivery failure to report immediately; do
not merge or retarget automatically.

## End state

Report the commit, pushed branch, PR URL if created, check state, risks, and
rollback. Never merge automatically. Do not deploy: no Budget FR deployment
target is defined by this skill, and any future deployment requires documented
target details plus separate explicit authorization.
