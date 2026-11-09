# Config sources, state and dashboard (phase 2 design)

Design for castellan#21. Three config modes, an additive state log, and a dashboard. Decisions were made with the maintainer on 2026-11-09; the sections below are the contract the child issues implement.

## Modes

| Source    | Policy comes from                                         | Who uses it                                   |
| --------- | --------------------------------------------------------- | --------------------------------------------- |
| `repo`    | `.castellan.yml` in each repo (today's behavior, default) | one repo, everything in git                   |
| `central` | one YAML shared by an owner, plus each repo's file on top | orgs that want one policy in git, no database |
| `db`      | DynamoDB documents, plus each repo's file on top          | orgs that edit policy in the dashboard        |

The source is chosen per deployment, never per repo:

- Lambda: env `CASTELLAN_CONFIG_SOURCE` (`repo` when unset).
- CLI: `--config-source`, same values, an alias for the env var.
- Action: input `config-source`, same values.

`central` needs nothing else to be set (see the default locator below). `db` needs `CASTELLAN_TABLE` and AWS credentials; without them the run fails with `config source db needs CASTELLAN_TABLE and AWS credentials`. There is no silent fallback to `repo`.

The source lands on `Env` in `src/pipeline.ts`, so all three adapters inherit it. `repoConfig` resolves the layers and the rest of the pipeline keeps receiving one `Config`.

## Central locator

`CASTELLAN_CENTRAL_CONFIG`, one string, the prefix picks the backend:

| Value             | Reads                                                                  |
| ----------------- | ---------------------------------------------------------------------- |
| unset             | `<event owner>/.github` repo, file `castellan.yml`, default branch     |
| `owner/repo:path` | that repo and path, default branch; `:path` optional (`castellan.yml`) |
| `s3://bucket/key` | that object                                                            |

The git forms use the App token the pipeline already has (`contents:read`), so the installation must cover the central repo. A deployment holds one installation id (`src/secrets.ts`), so today one deployment serves one org; the unset form is per owner so that a later multi-installation deployment reads each org's own file without a config change.

The central file is read once per invocation per owner, memoized in a map the Lambda creates per invocation (not on the container-scoped `Env` that `createHandler` keeps). Nothing is cached across invocations, so a merged change applies on the next event or sweep.

## Merge rules

Layers, lowest first: central or db document(s), then the repo's `.castellan.yml`. Built-in defaults are not a layer: the raw documents are merged, then the existing zod schema validates the result once and fills absent keys. A repo file that sets `skip_branches` therefore still replaces the built-in list, exactly as in `repo` mode.

- Scalars and objects: the upper layer wins per key, recursively.
- Arrays: appended, lower then upper, exact-string dedupe, order kept. This applies to every array key: `prompt.guidance`, `paths.protected`, `paths.release`, `paths.migrations`, `trustedAuthors`, `skip_branches`, `triage.priority_labels`.
- Replace instead of append: suffix the key with `!` in the upper layer, for example `guidance!:` or `skip_branches!:`. The `!` spelling is accepted only in documents that have a layer below them; the merged result never contains it.

```yaml
# <owner>/.github: castellan.yml
models:
  review: us.anthropic.claude-sonnet-4-6
prompt:
  guidance:
    - Reject changes to CI workflows without a maintainer approval.

# plugin-cron: .castellan.yml
mode: enforce
prompt:
  guidance: # appended after the central entry
    - Cron expressions must have a test.
skip_branches!: # replaces, does not append
  - release-plz-*
```

In `db` mode the layers are `owner/*` document, then `owner/repo` document, then the repo file, with the same rules.

## Failure semantics

| Situation                                        | Result                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `central`: file missing, invalid YAML, S3 denied | fail closed for every repo of that owner: defaults, `config_invalid` escalation with the error |
| `db`: no document for `owner/*` nor `owner/repo` | defaults plus repo file. A fresh table is the normal first state                               |
| `db`: table unreachable or document invalid      | fail closed as above                                                                           |
| repo file invalid in any mode                    | fail closed, as today                                                                          |

`central` is an explicit operator choice, so an absent file is a misconfiguration, not a fallback.

## Guarantees kept

- Kill switch: `CASTELLAN_REPOS` empty still disables everything, in every mode.
- Base branch policy: the repo file is still read at the PR's base ref. Central git files are read at the central repo's default branch, which branch protection covers.
- Policy edits escalate: a PR in the central repo that touches the central path escalates, like a `.castellan.yml` edit. That repo must be inside `CASTELLAN_REPOS` for castellan to see it; the Lambda logs a warning at startup when the central locator is a git repo outside the allowlist. The S3 form has no PR path: protect it with IAM, it is out of band.
- Model veto-only: unchanged, the sources only change where `Config` comes from.

## Database

One DynamoDB table, `CASTELLAN_TABLE`, string keys `pk` and `sk`.

| Item           | `pk`                                    | `sk`                                                              | Attributes                                                                                                                     |
| -------------- | --------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| config version | `config#owner/repo` or `config#owner/*` | `v<N>`                                                            | `yaml` (the document text), `updatedBy`, `updatedAt`                                                                           |
| config pointer | same                                    | `current`                                                         | `version`                                                                                                                      |
| event          | `repo#owner/repo`                       | `<iso timestamp>#pr-<n>#<headSha>` or `<iso timestamp>#issue-<n>` | `verdict`, `reasons`, `model`, `inputTokens`, `outputTokens`, `costUsd`, `source` (`llm`, `cache`, `skipped`), `ttl` (90 days) |

Config documents are stored as YAML text, not decomposed fields, so there is one schema (`src/config.ts`) and one validator for all three sources. Every edit writes a new version and moves `current`; history is free.

Events are written whenever `CASTELLAN_TABLE` is set, independent of the config source. Issue triage writes an `issue-<n>` event with its model usage. A sweep writes one `sweep#owner` item (`sk = <iso timestamp>`, attributes `repos`, `durationMs`, `errors`) so the dashboard can show the last sweep. The sticky-comment cache stays the source of truth for review reuse; the table is additive and nothing migrates. Month cost is summed on read over the current calendar month over `source = llm` events only, so a cache hit (which carries the original call's `costUsd`) is never counted twice. No counters.

## Dashboard

Served by the existing Lambda under `/dashboard`, server-rendered HTML, no client framework.

- Login: a GitHub OAuth App (client id and secret stored in the existing `castellan/github-app` secret). Callback is the Function URL plus `/dashboard/callback`. Only logins listed in `CASTELLAN_ADMINS` (comma separated) may sign in. Session is a signed cookie (HMAC with the webhook secret, 12 hours).
- Pages: repos (mode, source, month cost, last sweep), repo detail (last 50 verdicts with reasons and PR links), config editor (YAML text area plus a guidance list with add and remove). Saving validates with the zod schema and writes a new version. The editor is read-only with a banner unless the source is `db`.

## Delivery

Three child issues, in order:

1. Config sources: modes, locator, merge rules, CLI and Action plumbing, docs. No infra change. After this ships, AoE moves to `central`.
2. State log: event writes, Terraform draft PR in infra for the table and IAM.
3. Dashboard: OAuth, the three pages, the editor.

AoE rollout after child 1: infra PR sets `CASTELLAN_CONFIG_SOURCE=central`; `agent-of-empires/.github` gets `castellan.yml` with the shared block (models, prompt base, limits, triage); the eight repo files shrink to their deltas (mode, repo-specific prompt base, protected paths).

Follow-ups filed separately: a static Astro dashboard on castellan.agent-of-empires.com over a JSON API, a Postgres backend, team or org membership based dashboard auth, a `file://` central locator.
