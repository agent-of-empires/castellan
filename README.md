# Castellan

A stateless merge gate and issue triage bot for GitHub. It re-evaluates a PR on every
event and posts one brief with a verdict (`merge`, `escalate`). Rules decide; the
model can only veto.

**Status:** bootstrap only. No gate behavior yet. Design and rollout plan:
[RFC agent-of-empires#5502](https://github.com/agent-of-empires/agent-of-empires/issues/5502).

## Triage

Copy [templates/needs-triage.yml](templates/needs-triage.yml) into `.github/workflows/` to add `needs-triage` on issue open. Castellan then fills only the missing priority, `area:*` and type labels and the project Size, Status, Priority and Roadmap (features only) fields; Fit is never set. Project and option ids are resolved by name at runtime from `project.name` and the `project.*Field` keys in `.castellan.yml`. In `shadow` it comments the proposal; in `enforce` it applies it, removes `needs-triage` and comments the reasons. A `ready-for-agent` suggestion is always comment only.

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
