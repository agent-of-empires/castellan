# Castellan

A stateless merge gate and issue triage bot for GitHub. It re-evaluates a PR on every
event and posts one brief with a verdict (`merge`, `escalate`). Rules decide; the
model can only veto.

**Status:** bootstrap only. No gate behavior yet. Design and rollout plan:
[RFC agent-of-empires#5502](https://github.com/agent-of-empires/agent-of-empires/issues/5502).

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

Requires a `RELEASE_PLEASE_TOKEN` repo secret (PAT or app token) so the published release triggers the workflow.

See [AGENTS.md](AGENTS.md) for contribution conventions.

## License

MIT
