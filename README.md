# Castellan

A stateless merge gate and issue triage bot for GitHub. It re-evaluates a PR on every
event and posts one brief with a verdict (`merge`, `escalate`). Rules decide; the
model can only veto.

Design and rollout plan:
[RFC agent-of-empires#5502](https://github.com/agent-of-empires/agent-of-empires/issues/5502).

## Triage

Copy [templates/needs-triage.yml](templates/needs-triage.yml) into `.github/workflows/` to add `needs-triage` on issue open. The target repo must have a `needs-triage` label (name set by `labels.needsTriage`); the workflow does not create it.

While `needs-triage` is present, castellan fills only the missing priority, `area:*` and type labels and the project Size, Status, Priority and Roadmap (features only) fields. Fit is never set. Project, field and option ids are resolved by name at runtime. Priority labels, the Status-by-priority table and the Roadmap-by-Status options come from `triage.*` in `.castellan.yml`; the project from `project.name` and `project.*Field`. A name that cannot be found (project, field, option or label) fails closed: nothing is written. In `shadow` it comments the proposal; in `enforce` it applies it, comments the reasons and removes `needs-triage` last. A `ready-for-agent` suggestion is always comment only.

## Acting on a verdict

`mode` is read from `.castellan.yml` on the base SHA only. `off` does nothing. `shadow` posts the brief and the `castellan` status. `enforce` also approves the head SHA and enables squash auto-merge, as the GitHub App installation, and only for a `merge` verdict. A `merge` that touches `paths.protected`, `paths.release`, a file owned by `teams.protected`, `.castellan.yml`, CODEOWNERS or `.github/` is downgraded to `escalate` in code. If the head moved since evaluation, nothing is approved or queued. Re-running sequentially on the same head adds no second approval and does not re-queue. There is no lock, so two concurrent deliveries on the same head can both approve. If queuing fails, the status is set back to `pending` and the comment says why.

## Lambda

`dist/lambda/index.mjs`, handler `index.handler`, Node 22 ESM, behind a Function URL with auth `NONE`. The `X-Hub-Signature-256` HMAC is verified (timing-safe) on the raw body before anything is parsed; a bad one gets 401 and no side effects.

- `CASTELLAN_APP_SECRET_ARN`: Secrets Manager JSON with `app_id`, `installation_id`, `private_key`, `webhook_secret`. Read once per container.
- `CASTELLAN_REPOS`: comma list of `owner/repo` the bot acts on. Empty is a kill switch: every event and sweep is ignored.

Routed webhooks: `pull_request` (opened, synchronize, reopened, ready_for_review), `check_suite` (completed), `pull_request_review` (submitted), `status`, and `issues` (opened, triage). `check_run` is not routed: it fires once per check, so a CI run would start many parallel evaluations of one head; `check_suite` fires once. A `check_suite` with no attached PR (fork PRs) is mapped to PRs by head SHA. Castellan's own `castellan` status and its own approvals are ignored so they cannot re-trigger it. The `{"source":"sweep"}` EventBridge event runs the same pipeline over every open PR and `needs-triage` issue in `CASTELLAN_REPOS`, three at a time, and stops starting work when under 40 seconds remain. The App login used to find its own comment and approval is `<slug>[bot]` from `GET /app`.

Responses: 401 for a bad signature, 400 for a signed body that is not JSON, 500 only for infrastructure failures (secrets, GitHub connection); a failing PR or issue is logged and returns 200. If anything fails after the PR head is known, the `castellan` status is set to `pending` ("internal error") so a stale `success` cannot stay.

GitHub marks a webhook delivery as timed out after 10 seconds. The Lambda keeps running and finishes the work; the delivery just shows as failed in GitHub.

`llm.provider: anthropic` needs an API key, and the Lambda has none today (only Bedrock works). Without one the review fails closed to `escalate`.

The handler lives in `src/lambda.ts`, the per-PR pipeline in `src/pipeline.ts`. The SDKs are bundled, not externalized, so the zip does not depend on the Lambda runtime's SDK version. The bundle ships no sourcemap. `pnpm test:bundle` imports `dist/lambda/index.mjs` as a real ES module after `pnpm build`.

## Self-hosting without AWS

Both adapters call the same entry as the Lambda adapter will: `runForPr` and `runForIssue` in `src/run.ts`. They are separate bundles (`dist/action`, `dist/cli`), never part of the Lambda zip.

**GitHub Action.** Copy [templates/castellan.yml](templates/castellan.yml) into `.github/workflows/`. It runs on `pull_request`, `issues`, and a 30 minute `schedule` sweep of every open non-draft PR and every issue labeled `needs-triage`.

- `pull_request_target` is refused in code, because it would give write secrets to fork code. A `pull_request` from a fork does nothing (its token is read-only); the next sweep evaluates it.
- Credentials are inputs: `github-token` (default `github.token`), or `app-id`, `installation-id`, `private-key` and `bot-login` (an App wins). `mode` overrides `.castellan.yml`, which is otherwise read from the base SHA; a value other than `off`, `shadow` or `enforce` fails the run.
- The workflow needs `contents: read`, `pull-requests: write`, `issues: write`, `statuses: write` and `checks: read` (the template sets them).
- A workflow token cannot approve, cannot write org project fields and cannot read org teams, so `enforce`, triage fields and `teams.maintainers` / `teams.protected` all need an App.
- `anthropic-api-key` only matters when `.castellan.yml` sets `llm.provider: anthropic`; the default, bedrock, needs ambient AWS credentials.
- The composite action runs `pnpm install` and `pnpm build` on every run and sets up Node 22, which replaces the caller's Node version. Move to a release-built `dist` if either matters.

**CLI.** `castellan <owner/repo> <number> [--issue] [--mode off|shadow|enforce] [--dry-run]` after `pnpm build` (`node dist/cli/index.mjs`). Credentials come from `GITHUB_TOKEN`, or `CASTELLAN_APP_ID`, `CASTELLAN_INSTALLATION_ID`, `CASTELLAN_PRIVATE_KEY` and `CASTELLAN_BOT_LOGIN`; plus `ANTHROPIC_API_KEY`. `--mode` overrides the base SHA config. `--dry-run` forces `shadow` regardless of `--mode`, writes nothing to GitHub (REST writes are swallowed, GraphQL mutations throw), and prints the brief it would have posted.

## Eval

Replays closed PRs as of their last head SHA, with human reviews hidden, and compares each verdict to what humans did. Output is markdown.

```bash
pnpm build
GITHUB_TOKEN=... pnpm eval --repo owner/repo --since 90d --out report.md
pnpm eval   # replays eval/fixtures; CI runs this
```

- **Precision:** share of `merge` verdicts that humans merged with no changes requested, no revert, and no commit pushed by anyone but the author or a bot (`changed_by_human`, since replay judges the final head, which would already include that fix). Other outcomes are `changes_requested`, `reverted` (a later merged PR says `Reverts #n`) and `closed`.
- **Coverage:** share of all PRs considered that reached `merge` (the share among judged, non-skipped PRs is a second line), median CI green to merge for that class, and merges with zero human review split into castellan `merge` vs nobody reviewed, next to the agent-of-empires#5485 baseline.
- Exit code is 1 when any `merge` verdict is a mistake. With `--save`, each live mistake is written to `eval/fixtures/` so CI keeps checking it.
- Replay never calls the model. A live run reviews each rule candidate once (Bedrock credentials, or `ANTHROPIC_API_KEY` for the `anthropic` provider) and `--save` stores that `review` in the fixture. CODEOWNERS and linked-issue labels are not fetched yet, so live runs escalate or merge without the `protected_owner` and external bug-label checks. The review input is title, body and diff only, without the linked issue body, so `intent_match` is judged without it.

Metric definitions: [RFC agent-of-empires#5502](https://github.com/agent-of-empires/agent-of-empires/issues/5502), Rollout.

## Development

Requires Node 22 and pnpm.

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build   # dist/lambda, dist/action, dist/cli
```

## Releases

1. Conventional commits on `main` keep a release-please PR open with the next version and changelog.
2. Merging that PR tags `vX.Y.Z` and publishes a GitHub release.
3. The release workflow builds the bundle and attaches `castellan-lambda-<version>.zip` and its `.sha256`.

## Deploy

Infra (Lambda, role, budget) lives in [agent-of-empires/infra](https://github.com/agent-of-empires/infra) (`aws/castellan.tf`). To ship a release, run the `Deploy` workflow (Actions, Run workflow) with the release tag. It downloads `castellan-lambda-<version>.zip`, verifies its checksum and updates the function code. Rollback is rerunning it with an older tag. The workflow only works from `main`.

## Website

`website/` is an Astro site for https://castellan.agent-of-empires.com. The `Website` workflow builds it on PRs and deploys it to GitHub Pages on push to `main`. Run it locally with `cd website && npm ci && npm run dev`.

See [AGENTS.md](AGENTS.md) for contribution conventions.

## License

MIT
