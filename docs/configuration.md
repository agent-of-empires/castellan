# Configuration

Policy lives in `.castellan.yml` at the repo root. The schema is `src/config.ts`; this page is derived from it.

- **Where it is read from.** For a PR, from the PR's base commit (`pull_request.base.sha`), never the head, so a PR cannot loosen its own gate. For issue triage and the sweep's repo listing, from the repo's default branch.
- **Every key is optional.** A missing file, an empty file and `{}` all mean "all defaults" (`mode: shadow`).
- **Unknown keys are rejected**, at any depth.
- **An invalid file fails closed.** If the file cannot be read, is not valid YAML or fails validation, the PR is escalated with rule `config_invalid` and the error as the reason. Config falls back to defaults, so nothing is approved or queued (a `mode` override from the Action input or CLI flag still applies, but an escalated PR is never approved). Triage on an invalid config throws and writes nothing.
- **Changing the file always escalates.** See [security.md](security.md).

Changes to `prompt.*` or `models.review` change the prompt hash, so the next evaluation of each open PR calls the model again.

## Keys

### `mode`

`off | shadow | enforce`. Default `shadow`.

- `off`: nothing is evaluated, posted or written. PRs are skipped, triage returns "off".
- `shadow`: posts the brief and the `castellan` commit status, which is `success` for a verdict ("shadow: would merge" or "shadow: would escalate (<first reason>)") and `pending` ("shadow: waiting for CI") while CI is unsettled. The model also runs on every PR that is not skipped, including rule escalations, where its review is advice and the rules decide. Triage comments a proposal. Nothing is approved, merged, labeled or written to a project.
- `enforce`: the model runs only for rule candidates. Additionally approves the head SHA and enables squash auto-merge for a `merge` verdict; triage applies labels and project fields and removes `needs-triage`.

The GitHub Action input `mode` and the CLI `--mode` flag override this key. Any value other than the three above fails the run.

```yaml
mode: shadow
```

### `limits`

A PR over any limit escalates. All are positive integers.

| Key                      | Default | Counts                                                                              |
| ------------------------ | ------- | ----------------------------------------------------------------------------------- |
| `limits.maxLines`        | `100`   | additions plus deletions across all files                                           |
| `limits.maxFiles`        | `5`     | changed files. More than 200 files (the snapshot cap) always counts as over         |
| `limits.maxTopLevelDirs` | `2`     | distinct first path segments; files at the repo root count as one extra "directory" |

```yaml
limits:
  maxLines: 200
  maxFiles: 8
  maxTopLevelDirs: 3
```

### `paths`

Lists of CODEOWNERS style patterns, matched against each changed path. A pattern with no slash matches at any depth; `dir/` and `dir/**` recurse; `dir/*` does not; a leading `/` anchors to the root; `*`, `**` and `?` are supported. Any match escalates.

| Key                | Default                                                             | Rule id                                      |
| ------------------ | ------------------------------------------------------------------- | -------------------------------------------- |
| `paths.protected`  | `[]`                                                                | `protected_path`                             |
| `paths.release`    | `[]`                                                                | `protected_path` (same rule, different list) |
| `paths.migrations` | `["migrations/", "migration/", "db/migrate/", "alembic/versions/"]` | `migration`                                  |

Setting `paths.migrations` replaces the default list; it does not extend it.

```yaml
paths:
  protected: ["src/auth/", "/Cargo.toml"]
  release: ["release-plz.toml"]
  migrations: ["db/migrations/"]
```

### `teams`

| Key                 | Type                    | Default | Used for                                                                                                     |
| ------------------- | ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `teams.maintainers` | team slug               | unset   | author class `maintainer`: the PR author is an active member                                                 |
| `teams.protected`   | team slug or `org/slug` | unset   | rule `protected_owner`: any changed file whose last matching CODEOWNERS rule names `@<org>/<slug>` escalates |

The org is always the repo owner from the event; an `org/` prefix on `teams.protected` is ignored, and `teams.maintainers` is a bare slug. Both need an App with organization members read access: a workflow `GITHUB_TOKEN` cannot read org teams. If a team cannot be found or read, the evaluation fails closed: the `castellan` status on the head is set to escalate with the description `castellan: internal error` and the error is rethrown (logged on the Lambda, exit 1 for the Action and CLI). The author is never silently treated as a non-member.

`teams.protected` is the only thing that makes castellan read CODEOWNERS, from the base commit, trying `.github/CODEOWNERS`, `CODEOWNERS`, then `docs/CODEOWNERS`. Only owners written as `@org/team` are compared; individual users never match.

```yaml
teams:
  maintainers: maintainers
  protected: security
```

### `trustedAuthors`

`string[]` of GitHub logins, default `[]`. Exact, case sensitive match. A trusted author who is not in `teams.maintainers` gets author class `trusted`.

```yaml
trustedAuthors: ["octocat"]
```

### `skip_branches`

`string[]` of globs, default `["release-staging/*", "release-plz-*"]`. A PR whose head branch matches a glob is never evaluated (rule `skip_branch`). The glob must match the whole branch name; `*` does not cross `/`, `**` does. Setting it replaces the default list.

```yaml
skip_branches: ["release-staging/*", "release-plz-*", "renovate/**"]
```

### `labels`

Label names castellan reads or writes.

| Key                  | Default        | Used for                                                                                            |
| -------------------- | -------------- | --------------------------------------------------------------------------------------------------- |
| `labels.needsTriage` | `needs-triage` | triage runs only while an issue carries it; the sweep lists issues by it; removed last in `enforce` |
| `labels.bug`         | `bug`          | external fix PRs must close an issue with this label; the triage `bug` type label                   |
| `labels.feature`     | `enhancement`  | the triage `feature` type label                                                                     |

```yaml
labels:
  needsTriage: needs-triage
  bug: bug
  feature: enhancement
```

### `project`

Names of the org Projects v2 board and its single select fields. Ids are resolved by name at runtime. The board must be owned by the repo's org.

| Key                     | Default            |
| ----------------------- | ------------------ |
| `project.name`          | `Agent of Empires` |
| `project.statusField`   | `Status`           |
| `project.priorityField` | `Priority`         |
| `project.sizeField`     | `Size`             |
| `project.roadmapField`  | `Roadmap state`    |

```yaml
project:
  name: Engineering
  roadmapField: Roadmap
```

### `triage`

| Key                         | Default                                                   | Meaning                                                                                                                  |
| --------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `triage.priority_labels`    | `["P0", "P1", "P2", "P3"]`                                | Priority labels, most urgent first, at least one. The model must pick one, and it must exist as a label in the repo      |
| `triage.status_by_priority` | `{P0: Ready, P1: Ready, P2: Backlog, P3: Backlog}`        | Project Status option set for each priority. Every entry in `priority_labels` needs a key here, or the config is invalid |
| `triage.roadmap_by_status`  | `{Ready: "📋 Planned", Backlog: "💡 Future / Exploring"}` | Roadmap option set for a feature, keyed by the Status                                                                    |

```yaml
triage:
  priority_labels: [P0, P1, P2]
  status_by_priority: { P0: Ready, P1: Ready, P2: Backlog }
  roadmap_by_status: { Ready: Planned, Backlog: Future }
```

### `llm`

| Key            | Default   | Meaning                                                                                                                                                                                                                                                                     |
| -------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm.provider` | `bedrock` | `bedrock` uses the ambient AWS credential chain (SigV4). `anthropic` needs an API key: `ANTHROPIC_API_KEY` for the CLI and eval, the `anthropic-api-key` input for the Action. The Lambda has no way to pass one today, so on Lambda `anthropic` fails closed to `escalate` |

```yaml
llm:
  provider: bedrock
```

### `models`

| Key             | Default with `bedrock`           | Default with `anthropic` |
| --------------- | -------------------------------- | ------------------------ |
| `models.review` | `us.anthropic.claude-sonnet-5-5` | `claude-sonnet-5-5`      |
| `models.triage` | `us.anthropic.claude-haiku-5-5`  | `claude-haiku-5-5`       |

With `bedrock`, a model id must start with `anthropic.`, `us.` or `global.`, or the config is invalid.

Only these ids have a built in price: the four defaults above, `us.anthropic.claude-sonnet-4-6`, `claude-sonnet-4-6`, `us.anthropic.claude-haiku-4-5-20251001-v1:0` and `claude-haiku-4-5-20251001-v1:0`. Any other model id fails every call with the `budget` reason ("no price for model"), so PRs escalate with `llm_unavailable` and triage reports an error. No shipped entrypoint accepts a price override.

```yaml
models:
  review: us.anthropic.claude-sonnet-5-5
```

### `prompt`

The review system prompt is `prompt.base`, then the numbered `prompt.guidance` entries, then a fixed output format block that cannot be changed.

| Key               | Default                                                                                                                                                                                | Meaning                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `prompt.base`     | built in: "You review a pull request for a merge gate. Decide whether the change matches the linked issue and the PR description, and whether it adds behavior beyond what was asked." | Replaces the base text                                |
| `prompt.guidance` | `[]`                                                                                                                                                                                   | One entry per house rule, appended as a numbered list |

Guidance can only make the model stricter in effect: the model can veto, never approve. See [security.md](security.md). `prompt.*` applies to the PR review only; the triage prompt is fixed.

```yaml
prompt:
  guidance:
    - A third party integration belongs in a plugin.
    - Bug fixes need a reproduce then fix test.
```

### A full example

```yaml
mode: shadow
limits: { maxLines: 100, maxFiles: 5, maxTopLevelDirs: 2 }
paths:
  protected: ["src/auth/"]
  release: ["Cargo.toml"]
teams: { maintainers: maintainers, protected: security }
trustedAuthors: ["octocat"]
llm: { provider: bedrock }
prompt:
  guidance:
    - Prefer small, focused changes.
```

## Not configurable

These are fixed in code. Changing one is a code change and a release.

### Evaluation order

First rule with a hit decides; all hits of that one rule are listed, and the comment shows at most 3 reasons (`(+N more)` after). Skip rules run first, then `merge_conflict`, then the wait rule, then the other escalate rules, then the model.

**Skip (nothing is posted):** `draft`, `skipped_author` (only `dependabot[bot]`), `non_default_base`, `skip_branch`, `mode_off`.

**Wait (`ci_unsettled`):** CI has not settled when a required check has no run on the head SHA, or any check run is pending, queued or in progress. Nothing is posted and the model is not called; the `castellan` status is `pending` with "castellan: waiting for CI" ("shadow: waiting for CI" in `shadow`). On the Lambda the PR is evaluated again on `check_suite` completed, on `status` events and by the sweep, with no wait ceiling. The GitHub Action has no `check_suite` or `status` trigger, and its own job is in progress on the head during a `pull_request` run, so an Action install stays waiting until the scheduled run.

**Escalate, in order:**

| Rule id                              | Escalates when                                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `merge_conflict`                     | GitHub reports the PR as not mergeable (checked before the wait rule, because `pull_request` workflows do not run without a merge ref)                       |
| `castellan_config`                   | a changed path is `.castellan.yml` (at any depth)                                                                                                            |
| `codeowners_file`                    | a changed path is `CODEOWNERS`, `.github/CODEOWNERS` or `docs/CODEOWNERS`                                                                                    |
| `github_dir`                         | a changed path is under a `.github/` directory                                                                                                               |
| `protected_path`                     | a path matches `paths.protected` or `paths.release`                                                                                                          |
| `protected_owner`                    | a path is owned by `teams.protected`                                                                                                                         |
| `required_check`                     | a check required by the active rulesets for the base branch did not end in success, neutral or skipped (as on GitHub)                                        |
| `check_failing`                      | a check run on the head SHA has any conclusion other than success, neutral or skipped                                                                        |
| `coderabbit`                         | the latest non-comment review by `coderabbitai[bot]` requests changes                                                                                        |
| `max_lines`, `max_files`, `max_dirs` | over `limits.*`                                                                                                                                              |
| `diff_truncated`                     | the diff is over 30,000 characters                                                                                                                           |
| `migration`                          | a path matches `paths.migrations`                                                                                                                            |
| `generated_only`                     | every changed file is a lockfile (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `Cargo.lock`), a `*.generated.*` file or under `dist/` or `generated/` |
| `human_changes_requested`            | the latest non-comment review of any human reviewer is changes requested, on any commit                                                                      |
| `body_truncated`                     | the PR body is over 3,000 characters                                                                                                                         |
| `stacked`                            | the body contains `stacked on #<n>` (case insensitive)                                                                                                       |
| `author_class`                       | see below                                                                                                                                                    |

Required checks come from the rulesets API only; classic branch protection is not read. Checks are every check run on the head SHA, not only the required ones. Commit statuses (not check runs) are not evaluated.

**Model.** Only a PR that passed every rule is reviewed. The model returns `intent_match`, `new_behavior` and findings with severity `blocker`, `concern` or `nit`. A `merge` needs `intent_match` true, `new_behavior` false and no `blocker`. Any failure of the model (no key, no price for the model, timeout, SDK error, unparsable output) escalates with `llm_unavailable`. `concern` and `nit` findings appear in the brief as a checklist and do not block.

### Author classes

Derived from team membership and `trustedAuthors`, never from login patterns, except that any login ending in `[bot]` is a bot.

| Class        | How                                                            | Eligible for `merge` when                                                                                                    |
| ------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `bot`        | login ends with `[bot]` (except the skipped `dependabot[bot]`) | never                                                                                                                        |
| `maintainer` | active member of `teams.maintainers`                           | all other rules pass                                                                                                         |
| `trusted`    | listed in `trustedAuthors`                                     | all other rules pass                                                                                                         |
| `external`   | everyone else                                                  | title is `fix:` or `fix(scope):`, the body has `Closes`, `Fixes` or `Resolves #n`, and one linked issue carries `labels.bug` |

For an external author, a `!` breaking change title, a `feat:` title and any title that is not `fix:` always escalate. Linked issues are read from the full body, before the 3,000 character cap. `maintainer` and `trusted` are treated identically today. Without `teams.maintainers`, nobody is a maintainer.

### Verdicts, comment and status

- Verdicts are `merge` and `escalate`. `send_back` is reserved and never emitted.
- One sticky comment per PR, found by the hidden marker `<!-- castellan` and by being authored by the App (or the token's bot login). It is edited in place, never duplicated. The verdict is the first line, the machine readable state block is always last, and the body stays under 65,000 characters (findings are dropped first).
- Brief layout: verdict line (with `(shadow)` in shadow), up to 3 reasons, Model review (or one line "Model: not run (rules decided)"), a collapsed Checks table and a collapsed Provenance list. The table is deduped by check name keeping the newest run (highest check run id), with failed, pending and skipped rows first. At most 3 reasons, 500 characters per reason, 50 rows in the check table. Provenance says whether the model was not run, `fresh` or cached from a sha.
- Reasons that quote model or PR text are made inert: no `@` mentions, links, URLs, HTML or dashes.
- Commit status context is `castellan`. In `enforce`, `merge` sets `success` ("castellan: merge") and `escalate` sets `pending` ("castellan: escalated to a human"). In `shadow` it is `success` for both verdicts, because `pending` reads as "waiting for status to be reported", and `pending` ("shadow: waiting for CI") only while CI is unsettled. It is never set to `failure`, so an escalation waits for a human instead of blocking.
- On an unexpected error after the head SHA is known, the status is set to `pending` ("castellan: internal error"; `success` "shadow: internal error" in `shadow`) so a stale verdict cannot stay.
- Escalate does not request reviewers or assign a team. The brief has a place for an owner team, but nothing fills it today.

### Acting (`enforce`)

- A `merge` that touches the config file, CODEOWNERS, `.github/`, `paths.protected`, `paths.release` or a `teams.protected` file is downgraded to `escalate` right before acting (rule `protected_guard`), even if the rules above let it through.
- The head SHA must not have moved. The approval, the auto-merge request and the immediate merge are all pinned to the evaluated SHA.
- Merge method is always squash.
- Approves as the App unless it already approved the same head. If auto-merge cannot be enabled because the PR is already mergeable ("clean status"), it merges immediately.
- If approving or queuing fails, the status goes to `pending` and the comment says why (`auto_merge_failed`).
- Re-running sequentially on the same head neither approves twice nor re-queues. There is no lock: two concurrent deliveries on the same head can both approve.

### Snapshot and model limits

- PR body 3,000 characters, diff 30,000 characters, 200 files. Over any of these, the item is truncated and the matching rule escalates.
- Labels, comments and review bodies are never fetched or shown to the model.
- Review input: title, body, diff, and the body of the first linked issue (3,000 characters). A `reviewerSummary` field with an 800 character cap exists in `src/llm.ts` but no caller populates it today. Model call: 30 second timeout, no retries, 2,048 output tokens.
- The model verdict is cached in the sticky comment per `(head SHA, prompt hash, review model)`. In `enforce` a rule escalated PR never reaches the model; in `shadow` it does, as advice.

### Triage

- Runs only while the issue has `labels.needsTriage`. Skipped when nothing is missing; in `enforce` the label is then removed.
- Fills only what is missing: the priority label, one `area:*` label, the type label (`labels.bug` or `labels.feature`), and the project Size, Status, Priority and (features only) Roadmap fields. It never overwrites a value that is set.
- The model must choose a priority from `triage.priority_labels` and an area from the repo's existing `area:*` labels, and both labels must exist. Sizes are `XS`, `S`, `M`, `L`, `XL`. Labels are not created.
- Every name (project, field, option, label) is resolved before any write. A name that cannot be found fails closed with nothing written.
- Fit is never set. `ready-for-agent` is only ever suggested in the comment, never applied.
- No result is cached: each run on a `needs-triage` issue calls the model and, in `shadow`, posts a new comment.

### Runtime

- Lambda sweep and webhook jobs run 3 at a time and stop starting new work when under 40 seconds of Lambda time remain.
- The Action sweep evaluates sequentially.
