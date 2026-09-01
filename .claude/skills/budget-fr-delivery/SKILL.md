---
name: budget-fr-delivery
description: Prepare, deliver, and verify Budget FR changes in the lefevreste/budget-fr fork. Use for delivery readiness, required checks, conventional commits, pushes, fork pull requests, or CI verification. Do not use it to implement features or deploy an undefined target.
---

# Budget FR Delivery

Deliver Budget FR changes without crossing repository, authorization, or quality
boundaries.

## Start

1. Read the root `AGENTS.md` and every instruction applicable to the changed
   paths. Inspect the working tree before changing Git state.
2. Select exactly one mode below. `prepare` is the default and performs no
   commit, push, PR creation, merge, or deployment.
3. Run `scripts/check-delivery-context.sh` in `prepare` and again immediately
   before `deliver`. Stop on any error.
4. For behavior-changing Budget FR diffs, also apply the repository's
   `budget-fr-engineering` Review / validation mode when available.

## Modes

- **prepare** — read [references/prepare.md](references/prepare.md). Check the
  branch, remotes, diff, required controls, risks, and propose a conventional
  commit message.
- **deliver** — read [references/deliver.md](references/deliver.md). Use only
  after explicit approval of the prepared delivery to commit, push to `origin`,
  and optionally open the authorized fork PR.
- **verify** — read [references/verify.md](references/verify.md). Verify the fork
  PR, diff, CI, and residual risks without merging or deploying.

## Hard gates

- Refuse delivery from `master` or a detached HEAD.
- Require `origin` to resolve exactly to `lefevreste/budget-fr` for fetch and
  push. Require `upstream` to resolve to `actualbudget/actual`; use it only for
  reading and updating local knowledge or branches, never for pushing.
- Stop delivery when required lint, typecheck, or tests fail. Report cached,
  skipped, unavailable, or blocked checks honestly.
- Show the diff and risks and propose the commit message before committing.
  Commit only after explicit user approval.
- Push only to `origin`. Open PRs only in `lefevreste/budget-fr`, targeting its
  `master` branch. Never open a PR in or toward `actualbudget/actual`.
- Never merge automatically.
- Deployment is out of scope until a target is documented; even then, require
  separate explicit authorization.

Preserve unrelated working-tree changes and stage only the approved files. If
the diff, branch, remotes, required checks, or user authorization changes,
return to `prepare`.
