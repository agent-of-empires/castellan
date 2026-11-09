# Castellan

A stateless merge gate and issue triage bot for GitHub. It re-evaluates a PR on every
event and posts one brief with a verdict (`merge`, `escalate`). Rules decide; the
model can only veto.

**Status:** v0.1.0. Runs in `shadow` by default (comments and a status, nothing
approved or merged). `enforce` approves and queues a squash auto-merge, only for a
`merge` verdict. Design and rollout plan:
[RFC agent-of-empires#5502](https://github.com/agent-of-empires/agent-of-empires/issues/5502).

**Provider:** GitHub is the only supported provider today. The boundary is
[`src/github.ts`](src/github.ts); other providers are tracked in
[#35](https://github.com/agent-of-empires/castellan/issues/35).

## Self-hosting

Both paths run the same pipeline and read the same `.castellan.yml`. Full guide:
[docs/self-hosting.md](docs/self-hosting.md).

- **AWS Lambda.** Webhook driven, needed for `enforce`. Download
  `castellan-lambda-<version>.zip` from a release, run it behind a Function URL with
  a GitHub App secret in Secrets Manager, and set `CASTELLAN_REPOS`. Infra lives in
  [agent-of-empires/infra](https://github.com/agent-of-empires/infra)
  (`aws/castellan.tf`). Ship a release with the `Deploy` workflow.
- **GitHub Action.** No infra. Copy [templates/castellan.yml](templates/castellan.yml)
  into `.github/workflows/`. It reacts to PRs and issues and sweeps every 30 minutes.
  A workflow token cannot approve, so `enforce` needs an App.
- **CLI.** `node dist/cli/index.mjs <owner/repo> <number> [--issue] [--dry-run]`
  after `pnpm build`.

## Docs

- [docs/self-hosting.md](docs/self-hosting.md): Lambda, Action and CLI setup, App permissions, releases and deploys.
- [docs/configuration.md](docs/configuration.md): every `.castellan.yml` key with its default, and the behaviors that are not configurable.
- [docs/security.md](docs/security.md): the veto-only model, base-branch policy, webhook HMAC, identity and prompt injection boundaries.
- [docs/eval.md](docs/eval.md): replaying closed PRs to measure precision before enforcing.

## Development

Requires Node 22 and pnpm.

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build   # dist/lambda, dist/action, dist/cli
```

`website/` is an Astro site for https://castellan.agent-of-empires.com, deployed to
GitHub Pages by the `Website` workflow. Run it with `cd website && npm ci && npm run dev`.

See [AGENTS.md](AGENTS.md) for contribution conventions.

## License

MIT
