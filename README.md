# Castellan

A stateless merge gate and issue triage bot for GitHub. It re-evaluates a PR on every
event and posts one brief with a verdict (`merge`, `escalate`). Rules decide; the
model can only veto.

**Status:** bootstrap only. No gate behavior yet. Design and rollout plan:
[RFC agent-of-empires#5502](https://github.com/agent-of-empires/agent-of-empires/issues/5502).

## Triage

Copy [templates/needs-triage.yml](templates/needs-triage.yml) into `.github/workflows/` to add `needs-triage` on issue open. The target repo must have a `needs-triage` label (name set by `labels.needsTriage`); the workflow does not create it.

While `needs-triage` is present, castellan fills only the missing priority, `area:*` and type labels and the project Size, Status, Priority and Roadmap (features only) fields. Fit is never set. Project, field and option ids are resolved by name at runtime. Priority labels, the Status-by-priority table and the Roadmap-by-Status options come from `triage.*` in `.castellan.yml`; the project from `project.name` and `project.*Field`. A name that cannot be found (project, field, option or label) fails closed: nothing is written. In `shadow` it comments the proposal; in `enforce` it applies it, comments the reasons and removes `needs-triage` last. A `ready-for-agent` suggestion is always comment only.

## Acting on a verdict

`mode` is read from `.castellan.yml` on the base SHA only. `off` does nothing. `shadow` posts the brief and the `castellan` status. `enforce` also approves the head SHA and enables squash auto-merge, as the GitHub App installation, and only for a `merge` verdict. A `merge` that touches `paths.protected`, `paths.release` or a file owned by `teams.protected` is downgraded to `escalate` in code. If the head moved since evaluation, nothing is approved or queued. Re-running on the same head adds no second approval and does not re-queue.

## Development

Requires Node 22 and pnpm.

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build   # dist/lambda/index.mjs
```

## Releases

1. Conventional commits on `main` keep a release-please PR open with the next version and changelog.
2. Merging that PR tags `vX.Y.Z` and publishes a GitHub release.
3. The release workflow builds the bundle and attaches `castellan-lambda-<version>.zip` and its `.sha256`.

See [AGENTS.md](AGENTS.md) for contribution conventions.

## License

MIT
