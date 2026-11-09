# Security model

Castellan can approve and merge, so the design keeps a model, a PR author and a webhook sender from granting themselves a merge. Each section names the code that enforces it.

## The model can only veto

`decide` in `src/verdict.ts` turns rule outcomes and the model result into a verdict:

- Rules run first and decide. A rule escalation never reaches the model.
- Only a PR that passed every rule becomes a `candidate`. The model can turn a candidate into `escalate` (`intent_match` false, `new_behavior` true, or a `blocker` finding). It has no output that means "merge".
- A missing key, a missing price, a timeout, an SDK error or unparsable output all escalate. A failed review is never cached.
- The model reply is parsed against a strict schema: two booleans and a list of findings. Anything else is `invalid_output`.

So the worst a manipulated model can do is escalate, or fail to veto a change the rules already allowed.

## Policy comes from the base commit

- `.castellan.yml` is read at the PR's base SHA, never the head. A PR cannot loosen the gate it is judged by. The same base SHA is used to read CODEOWNERS for `teams.protected`.
- A PR that changes `.castellan.yml` (at any depth), CODEOWNERS (`CODEOWNERS`, `.github/CODEOWNERS`, `docs/CODEOWNERS`) or anything under `.github/` always escalates (rules `castellan_config`, `codeowners_file`, `github_dir`), so those need a human.
- The same check runs again inside `act` just before approving (`protected_guard`), together with `paths.protected`, `paths.release` and `teams.protected`, so a rule bug or reordering cannot let a protected change through.
- An invalid config escalates and falls back to defaults (`shadow`), never to a more permissive state.

Once a human merges a config change, it governs later PRs. Reviewing `.castellan.yml` changes is the control.

## Webhook authenticity (Lambda)

The Function URL has auth `NONE`, so the signature is the only gate.

- `X-Hub-Signature-256` is an HMAC SHA-256 of the raw request body with the App's webhook secret, compared with `timingSafeEqual` after a length check (`validSignature` in `src/lambda.ts`). The raw bytes are used (base64 decoded when the Function URL encodes the body), before anything is parsed.
- A missing or wrong signature returns 401 with no side effects. Only then is the body parsed, and then the repository is checked against `CASTELLAN_REPOS`.
- An empty `CASTELLAN_REPOS` returns 200 `disabled` for every event, a kill switch that needs no GitHub change.
- Deliveries are not de-duplicated by delivery id. This is safe because every run re-evaluates from GitHub state and a repeated run on the same head neither approves twice nor re-queues. Two concurrent runs on one head can both approve.
- The secret is loaded from Secrets Manager. A malformed secret fails with a fixed message so its content cannot reach the logs.
- The Action and CLI adapters have no webhook; they run inside GitHub Actions or your shell with your credentials. The Action refuses `pull_request_target` in code.

## Identity and the ruleset split

Castellan acts only as the GitHub App installation (or, in the Action and CLI token path, as the token's bot login). It never uses a human's credentials.

- The App's login is `<slug>[bot]` from `GET /app`. Its own sticky comment, approvals and `castellan` status events are recognized by that identity and ignored as triggers, so it cannot re-trigger itself. A comment from another account that contains the marker is not used.
- Every approval and merge call is pinned to the evaluated head SHA (`commit_id`, `expectedHeadOid`, `sha`). If the head moved, nothing is approved or queued. Re-approval is skipped if the App already approved that exact SHA.
- A workflow `GITHUB_TOKEN` cannot approve a PR, so `enforce` in the Action path needs an App.

The org side is not enforced by this repo and is a one time setup by an org owner, from the RFC:

- The `main` ruleset keeps required status checks, the merge queue, and force push and deletion blocks, with no bypass actor.
- A separate `main-review` ruleset holds only the pull request review rule (1 approval, code owner review, dismiss stale approvals, last push approval) with the castellan App as a bypass actor in pull requests only mode.

With that split the App can satisfy the review rule but can never skip a required check or the merge queue. Castellan reads required checks from the rulesets API (`GET /repos/{owner}/{repo}/rules/branches/{branch}`), so both rulesets are seen; classic branch protection is not read. Path scope is enforced by castellan's own rules, because an App cannot be a code owner.

## No state outside GitHub

Castellan has no database, queue or file store. Everything it remembers is on the PR:

- The sticky comment, with a hidden JSON state block as its last item: verdict, head SHA, prompt hash, model and, when the model ran, its result and cost.
- The `castellan` commit status.

The block caches only the model result, keyed by `(head SHA, prompt hash, review model)`. Rules and the verdict are recomputed from live GitHub data on every event. A block is trusted only from the App's own comment, only if it is the last thing in the body, only once (a body with two markers is ignored), and only if it passes the strict schema. Someone who can edit the App's comment could forge a cached model result, but still not skip a rule.

The Lambda keeps the App secret and the App connection in memory per container, nothing else.

## Prompt injection boundaries

The injectable text is the PR title, body, diff, linked issue body and, for triage, the issue title and body. The boundaries:

- **No code execution.** No PR code is checked out or run. The diff is text, and labels, comments and review bodies are never fetched.
- **Random delimiters.** Every untrusted field is placed between `BEGIN <name> <boundary>` and `END <name> <boundary>` lines, where the boundary is 16 random bytes per call, and the system prompt tells the model to treat the content as data. The boundary cannot be guessed ahead of time.
- **Caps.** Body 3,000, diff 30,000, linked issue 3,000 characters; truncation is stated to the model, and a truncated body or diff escalates before the model runs.
- **The model cannot grant.** The structural mitigation: even a fully hijacked reply can only escalate or fail to veto. See above.
- **Constrained outputs.** Strict schemas. Triage output must name a configured priority and an existing `area:*` label; it can only pick among values that already exist, never create labels, never set Fit, and `ready-for-agent` stays comment only.
- **Inert output.** Model and PR text rendered into comments is stripped of `@` mentions, links, raw URLs, HTML and dashes (`escapeText`), and the state block escapes `<`, `>` and dashes so model text cannot close the comment or forge a marker.
- **Fail closed.** Raw provider errors are kept out of comments.

What remains: a small, in scope PR from an eligible author whose text persuades the model that it matches its issue. The size limits, protected paths, the external author rule (a `fix:` linked to a bug labeled issue) and CI limit how much that can be.

## What the budget cap does

- `maxCostUsd` (`LlmDeps` in `src/llm.ts`) is a per call guard: before sending, castellan estimates the input cost as `(system + user characters) / 4` tokens at the model's input price, and a call above the cap fails with `budget`, which escalates. Output tokens are not estimated; `max_tokens` bounds them at 2,048.
- No shipped entrypoint (Lambda, Action, CLI) sets `maxCostUsd`, so this cap is not active today.
- The `budget` failure is also what an unpriced model id produces. That check is always active: only the four default model ids have a price, so any other `models.*` value fails closed.
- Spend is otherwise bounded by design: one review call per head SHA (cached), no call for rule escalated PRs, no retries, a 30 second timeout, and 3 concurrent jobs on the Lambda.
- The RFC's monthly Bedrock cap ($150 hard stop, alert at $75) is not in this repo. The README places the budget in the infra repo, not in the code.
- Triage has no cache, so a `needs-triage` issue costs one model call on every run that reaches it.

## Differences from the RFC

The code is the reference. Where [RFC agent-of-empires#5502](https://github.com/agent-of-empires/agent-of-empires/issues/5502) differs:

- Escalation does not request the CODEOWNERS team. It posts the brief and sets the status to `pending`.
- Shadow mode sets the real status (`success` or `pending`), not a neutral one.
- The RFC's "protected and release CODEOWNERS paths" are two config lists (`paths.protected`, `paths.release`) plus files owned by `teams.protected`, not every CODEOWNERS entry.
- The monthly budget is infra, not code (see above); the per call cap exists but is not wired.
- The kill switches are `mode: off` and an empty `CASTELLAN_REPOS`.

GitHub is the only supported provider today. All GitHub access goes through `src/github.ts` (the transport and client) and the `GithubTransport` passed through the pipeline; other providers are tracked in [#35](https://github.com/agent-of-empires/castellan/issues/35).
