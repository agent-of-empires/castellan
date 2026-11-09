# Self-hosting

Castellan runs three ways. All call the same pipeline (`evaluatePull` and `triageIssue` in `src/pipeline.ts`) and read the same [`.castellan.yml`](configuration.md).

|                                 | Needs                     | Good for                                  |
| ------------------------------- | ------------------------- | ----------------------------------------- |
| [AWS Lambda](#aws-lambda)       | AWS account, a GitHub App | real time reaction to webhooks, `enforce` |
| [GitHub Action](#github-action) | a workflow file           | trying it, `shadow`, no infra             |
| [CLI](#cli)                     | Node 22 and a token       | one PR or issue, dry runs                 |

GitHub is the only supported provider today. Everything provider specific sits behind `src/github.ts`; other providers are tracked in [#35](https://github.com/agent-of-empires/castellan/issues/35).

Start the PR gate in `shadow` (the default). It posts the brief and a status and approves or merges nothing. Triage has no shadow mode and writes labels and project fields for real as soon as it runs; set `triage.enabled: false` to hold it back while the PR gate is in `shadow` (see [configuration](configuration.md#triage)).

## AWS Lambda

`dist/lambda/index.mjs`, handler `index.handler`, Node 22 ESM, behind a Function URL with auth `NONE`. The handler lives in `src/lambda.ts` and the per-PR pipeline in `src/pipeline.ts`.

### Infrastructure

The Lambda, its role, the secret, the schedule and the AWS budget are defined in [agent-of-empires/infra](https://github.com/agent-of-empires/infra), file `aws/castellan.tf`. That repo is not reproduced here. To host it yourself, what the code needs is:

- A Lambda function on Node 22 with the zip from a release, handler `index.handler`, and a Function URL with auth `NONE` (the HMAC check is the gate). Set the function timeout well above 40 seconds: the sweep stops starting work when under 40 seconds remain, and one model call can take up to 30 seconds.
- Environment variables:
  - `CASTELLAN_APP_SECRET_ARN`: ARN of the secret below. Read once per container.
  - `CASTELLAN_REPOS`: comma separated list of `owner/repo` or `owner/*` (every repo of that owner the App is installed on, archived repos excluded from the sweep) the bot acts on. A repo without `.castellan.yml` gets the default `mode: shadow`, so a wildcard cannot enforce anywhere that did not opt in. Empty is a kill switch: every event and sweep is ignored.
  - `CASTELLAN_CONFIG_SOURCE`: `repo` (default) or `central`; see [configuration](configuration.md#config-sources). `db` is not implemented yet and fails the run.
  - `CASTELLAN_CENTRAL_CONFIG`: with `central`, `owner/repo[:path]` or `s3://bucket/key`; unset reads `<owner>/.github`, `castellan.yml`. For a git repo, add it to `CASTELLAN_REPOS`: the Lambda logs a warning at startup when it is not, because castellan then never sees PRs that edit the file. The role needs `s3:GetObject` for an S3 locator.
  - There is no budget env var; the only cost guards are the per-call `maxCostUsd` cap and the alert-only AWS Budget (50% and 100% of $150).
- Role permissions: read the secret (`secretsmanager:GetSecretValue`), and for `llm.provider: bedrock` (the default) invoke the configured models on Bedrock. The Anthropic provider cannot be used on Lambda today because there is no way to pass it a key; without one the review fails closed to `escalate`.
- An EventBridge rule that invokes the function with the input `{"source":"sweep"}`. It runs the same pipeline over every open PR and every `needs-triage` issue in `CASTELLAN_REPOS`, three at a time. The infra default is `rate(30 minutes)`; the sweep is also what picks up fork PRs.

### The secret

Secrets Manager, JSON string with all four keys (validated in `src/secrets.ts`; `app_id` and `installation_id` may be numbers or numeric strings):

```json
{
	"app_id": 123456,
	"installation_id": 7890123,
	"private_key": "-----BEGIN RSA PRIVATE KEY-----\n...",
	"webhook_secret": "a long random string"
}
```

### The GitHub App

Create an App, install it on the repos in `CASTELLAN_REPOS`, and set:

- **Webhook URL:** the Function URL. **Webhook secret:** the same value as `webhook_secret`.
- **Events:** `pull_request`, `check_suite`, `pull_request_review`, `status`, `issues`.
- **Repository permissions**, from the API calls the code makes:
  - Metadata: read.
  - Contents: read (config and CODEOWNERS). The immediate merge fallback calls the merge endpoint, which GitHub documents as needing Contents: write; grant it for `enforce`.
  - Pull requests: write (read PRs, files and reviews; approve; enable auto-merge).
  - Issues: write (sticky comment, triage comments and labels).
  - Commit statuses: write (the `castellan` status).
  - Checks: read (check runs on the head SHA).
- **Organization permissions:** Members: read (`teams.maintainers`, `teams.protected`); Projects: read and write (triage fields).

The org side of `enforce` (the `main` and `main-review` ruleset split, the App as bypass actor for the review rule only) is described in [security.md](security.md#identity-and-the-ruleset-split).

### What the Lambda handles

| Event                 | Runs on                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pull_request`        | `opened`, `synchronize`, `reopened`, `ready_for_review`                                                                                              |
| `check_suite`         | `completed`. A suite with no attached PR (fork PRs) is mapped to open PRs by head SHA                                                                |
| `pull_request_review` | `submitted`, except the App's own review                                                                                                             |
| `status`              | any, except the `castellan` context itself                                                                                                           |
| `issues`              | `opened`, `labeled`: triage. Without `needs-triage` it exits early; sweep is backup                                                                  |
| `{"source":"sweep"}`  | every open PR and `needs-triage` issue in `CASTELLAN_REPOS` (an `owner/*` entry is expanded through the installation, deduped against exact entries) |

`check_run` is not routed: it fires once per check, so one CI run would start many parallel evaluations of one head. `check_suite` fires once.

A PR whose CI has not settled (a required check has no run yet, or a run is queued or in progress) gets no comment and a `pending` `castellan` status reading "waiting for CI". The `check_suite` and `status` events and the sweep re-evaluate it, so nothing else is needed to resume.

Responses: 401 bad signature; 400 signed body that is not JSON; 200 for ignored events, repos not in `CASTELLAN_REPOS`, and per-PR failures (logged); 500 only for infrastructure failures (secrets, GitHub connection). If anything fails after the PR head is known, the `castellan` status is set to `pending` ("internal error"; `success` in `shadow`) so a stale verdict cannot stay. GitHub marks a delivery as timed out after 10 seconds; the Lambda keeps running and finishes the work, the delivery just shows as failed.

### Release, then Deploy

1. Conventional commits on `main` keep a release-please PR open with the next version and changelog.
2. Merging it tags `vX.Y.Z` and publishes a GitHub release.
3. The release workflow builds the bundle and attaches `castellan-lambda-<version>.zip` and `castellan-lambda-<version>.zip.sha256`.
4. Run the `Deploy` workflow (Actions, Run workflow) with the release tag. It downloads the zip, verifies the checksum, assumes the `castellan-deploy` role in `us-east-1` and runs `aws lambda update-function-code --function-name castellan`, then waits for the update to finish. The workflow only works from `main`.
5. Rollback is rerunning `Deploy` with an older tag.

The role ARN, function name and region are fixed in `.github/workflows/deploy.yml`; a fork that hosts its own function edits them there. The role and function are managed in the infra repo.

The SDKs are bundled, not externalized, so the zip does not depend on the Lambda runtime's SDK version. There is no sourcemap. `pnpm test:bundle` imports `dist/lambda/index.mjs` as a real ES module after `pnpm build`.

## GitHub Action

Copy [templates/castellan.yml](../templates/castellan.yml) into `.github/workflows/`. It runs on:

- `pull_request` (`opened`, `synchronize`, `reopened`, `ready_for_review`),
- `issues` (`opened`, `labeled`),
- a 30 minute `schedule` sweep of every open PR (the rules skip drafts) and every issue labeled `needs-triage`, and `workflow_dispatch`.

One item failing does not stop the sweep; the run exits 1 if any item failed. Runs are serialized per PR or issue.

**Inputs** (`action.yml`):

| Input                                      | Meaning                                                                                                                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-token`                             | Default `github.token`.                                                                                                                                               |
| `app-id`, `installation-id`, `private-key` | Act as a GitHub App instead. An App wins over the token, and its bot login comes from `GET /app`. Set all three or none.                                              |
| `bot-login`                                | Token path only: the identity castellan acts as, default `github-actions[bot]`.                                                                                       |
| `mode`                                     | Overrides `.castellan.yml`, which is otherwise read from the base SHA. Must be `off`, `shadow` or `enforce`.                                                          |
| `config-source`                            | `repo` (default), `central` or `db`. Any other value fails the run. `CASTELLAN_CONFIG_SOURCE` is the fallback. The locator is the `CASTELLAN_CENTRAL_CONFIG` env var. |
| `anthropic-api-key`                        | Only used when `.castellan.yml` sets `llm.provider: anthropic`. The default, `bedrock`, ignores it and needs ambient AWS credentials.                                 |

**Limits of the token path.** The workflow needs `contents: read`, `pull-requests: write`, `issues: write`, `statuses: write` and `checks: read` (the template sets them). A workflow token cannot approve, cannot write org project fields and cannot read org teams, so `enforce`, triage project fields and `teams.maintainers` and `teams.protected` all need an App.

**Fork PRs.** `pull_request_target` is refused in code, because it would give write secrets to fork code. A `pull_request` from a fork does nothing (its token is read only); the next sweep evaluates it.

**Triage.** Also copy [templates/needs-triage.yml](../templates/needs-triage.yml), which adds `needs-triage` when an issue is opened. The target repo must already have a label with the name in `labels.needsTriage`; the workflow does not create it. In the Action, a label added with `github.token` does not start other workflows, so the sweep is what triages it. The Lambda triages on the `issues.labeled` event.

**Cost of running it.** The composite action runs `pnpm install` and `pnpm build` on every run, and sets up Node 22, which replaces the caller's Node version. Move to a release built `dist` if either matters. The template pins a release (`@v0.1.0`).

## CLI

```bash
pnpm install && pnpm build
node dist/cli/index.mjs <owner/repo> <number> [--issue] [--mode off|shadow|enforce] [--config-source repo|central|db] [--dry-run]
```

- Credentials: `GITHUB_TOKEN`, or `CASTELLAN_APP_ID`, `CASTELLAN_INSTALLATION_ID` and `CASTELLAN_PRIVATE_KEY` (an App wins). `CASTELLAN_BOT_LOGIN` names the identity for the token path (default `github-actions[bot]`). `ANTHROPIC_API_KEY` for `llm.provider: anthropic`.
- `--config-source` is an alias for `CASTELLAN_CONFIG_SOURCE`; `CASTELLAN_CENTRAL_CONFIG` sets the central locator.
- `--issue` triages an issue instead of evaluating a PR.
- `--mode` overrides the base SHA config.
- `--dry-run` forces `shadow` regardless of `--mode` and writes nothing to GitHub (the pipeline runs with `dryRun`, REST writes are swallowed and GraphQL mutations throw). It prints the brief it would have posted. It is the way to check a config or a prompt change against a real PR.
- Exit code 1 when the item failed.

The Action and CLI are separate bundles (`dist/action`, `dist/cli`) and are never part of the Lambda zip.
