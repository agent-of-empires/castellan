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

`mode` is read from `.castellan.yml` on the base SHA only. `off` does nothing. `shadow` posts the brief and the `castellan` status. `enforce` also approves the head SHA and enables squash auto-merge, as the GitHub App installation, and only for a `merge` verdict. A `merge` that touches `paths.protected`, `paths.release`, a file owned by `teams.protected`, `.castellan.yml`, CODEOWNERS or `.github/` is downgraded to `escalate` in code. If the head moved since evaluation, nothing is approved or queued. Re-running sequentially on the same head adds no second approval and does not re-queue. There is no lock, so two concurrent deliveries on the same head can both approve. If queuing fails, the status is set back to `pending` and the comment says why. `act` is not yet wired into the entrypoint; that lands with the Lambda adapter.

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
pnpm build   # dist/lambda/index.mjs
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
