# Security model

Castellan can approve and merge, so the design keeps a model, a PR author and a webhook sender from granting themselves a merge. Each section names the code that enforces it.

## The model can only veto, unless a repo asks it to fix

`decide` in `src/verdict.ts` turns rule outcomes and the model result into a verdict:

- Rules run first and decide. In `enforce` a rule escalation does not reach the model, except when the only reasons are the size limits (`max_lines`, `max_files`, `max_dirs`, `diff_truncated`) and every other escalate rule is clean: then one review is made, still as advice, and the verdict stays the rules'. In `shadow` the model also reviews every escalation, but only as advice shown in the brief; the verdict stays the rules'.
- Only a PR that passed every rule becomes a `candidate`. The model can turn a candidate into `escalate` (`intent_match` false, `new_behavior` true, or a `blocker` finding). It has no output that means "merge".
- A missing key, a missing price, a timeout, an SDK error or unparsable output all escalate. A failed review is never cached.
- The model reply is parsed against a schema: two booleans and a list of findings (unknown keys inside a finding are dropped). Anything else is `invalid_output`.

So the worst a manipulated model can do is escalate, or fail to veto a change the rules already allowed.

## Policy comes from the base branch

- `.castellan.yml` is read at the PR's base branch (`pull_request.base.ref`, so the current tip, not the possibly stale `base.sha`), never the head. A PR cannot loosen the gate it is judged by. The same ref is used to read CODEOWNERS for `teams.protected`.
- A PR that changes `.castellan.yml` (at any depth), CODEOWNERS (`CODEOWNERS`, `.github/CODEOWNERS`, `docs/CODEOWNERS`) or anything under `.github/` always escalates (rules `castellan_config`, `codeowners_file`, `github_dir`), so those need a human.
- The same check runs again inside `act` just before approving (`protected_guard`), together with `paths.protected`, `paths.release` and `teams.protected`, so a rule bug or reordering cannot let a protected change through.
- An invalid config escalates and falls back to defaults (`shadow`), never to a more permissive state.

- With `CASTELLAN_CONFIG_SOURCE=central`, the central file is read at the central repo's default branch, so branch protection on that repo is the same guarantee. A PR in the central repo that touches the central path escalates (rule `castellan_config`), so the repo must be in `CASTELLAN_REPOS`. An S3 central file has no PR path; protect it with IAM.

Once a human merges a config change, it governs later PRs. Reviewing `.castellan.yml` changes is the control.

## Webhook authenticity (Lambda)

The Function URL has auth `NONE`, so the signature is the only gate.

- `X-Hub-Signature-256` is an HMAC SHA-256 of the raw request body with the App's webhook secret, compared with `timingSafeEqual` after a length check (`validSignature` in `src/lambda.ts`). The raw bytes are used (base64 decoded when the Function URL encodes the body), before anything is parsed.
- A missing or wrong signature returns 401 with no side effects. Only then is the body parsed, and then the repository is checked against `CASTELLAN_REPOS`: an exact `owner/repo` or an `owner/*` entry with the same owner, case-insensitively.
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
- One review per head, when the model anchored a finding to a diff line or `enforce` is approving. An approval is its own review and carries no comments. With `review.inline` on (off by default), findings are posted as a separate review: `COMMENT` in shadow, and in `enforce` `COMMENT` for concerns or nits and `REQUEST_CHANGES` for a blocker; a later head that reports no anchored blocker has that `REQUEST_CHANGES` dismissed, so a stale blocker cannot hold the pull request. A `merge` verdict never carries inline comments.
- The `castellan` commit status.

The block caches only the model result, keyed by `(head SHA, prompt hash, review model, thread key)`. The thread key digests the ids and anchors of the unresolved review threads the verdict answered, so a thread that appears, is resolved or goes stale re-runs the model even on an unchanged head. Since any account that can comment can change that key, a head is bounded to 3 thread-driven re-runs and the stored verdict stands afterwards, so a thread added or resolved past the cap is not assessed at that head and the brief says the cap was reached instead of counting threads the stored verdict never saw. A failed thread read is never treated as "no threads": the stored verdict is kept, or the run escalates without a model call. Rules and the verdict are recomputed from live GitHub data on every event. A block is trusted only from the App's own comment, only if it is the last thing in the body, only once (a body with two markers is ignored), and only if it passes the strict schema. Someone who can edit the App's comment could forge a cached model result, but still not skip a rule.

The Lambda keeps the App secret and the App connection in memory per container, nothing else.

## Prompt injection boundaries

The injectable text is the PR title, body, diff, linked issue body, the unresolved review threads, the changed files at the head, the findings carried from an earlier head, and, for triage, the issue title and body. The code is read as text and never executed. File contents are one of several fields not written by the PR author, alongside the linked issue body, the review threads and any pull request opened by someone else, so a comment placed in a repository file can reach the model too. The boundaries:

- **No code execution.** No PR code is checked out or run. The diff, the threads, the file contents and the carried findings are text. Labels, issue comments and review bodies are never fetched. Of the review threads, only the first comment of each unresolved thread is read, and castellan's own comments are dropped.
- **Random delimiters.** Every untrusted field is placed between `BEGIN <name> <boundary>` and `END <name> <boundary>` lines, where the boundary is 16 random bytes per call, and the system prompt tells the model to treat the content as data. The boundary cannot be guessed ahead of time.
- **Caps.** Body 3,000, diff 30,000, linked issue 3,000, review threads 12,000 characters in total, 25 threads at 900 characters each; changed files at most 6 reads, 12,000 characters each inside a 36,000 character field that counts its headers; carried findings 6 at 900 characters each inside 8,000. The thread, file and carried fields are built inside their caps, so the brief's counts are what the model read; truncation elsewhere is stated to the model, and a truncated body or diff escalates before the model runs.
- **The model cannot grant.** The structural mitigation: even a fully hijacked reply can only escalate or fail to veto. See above.
- **Constrained outputs.** Strict schemas. Triage output must name a configured priority and an existing `area:*` label; it can only pick among values that already exist, never create labels, never set Fit, and `ready-for-agent` stays comment only.
- **An earlier review's findings are still untrusted.** `previousFindings` is text a model produced from attacker controlled input (the PR body, diff, file contents and review threads), not the author's and not safe because castellan wrote it. It goes through the same random boundary and can only add a veto, so a hijacked run can keep a false blocker coming back, and it survives after the thread or file that caused it is removed. It cannot grant a merge, and it is capped at 6 findings of 900 characters each.
- **Suggestions are code, and stay inert by default.** The one field not passed through `escapeText`, because escaping would change what the author commits: a `suggestion` block is the model's replacement text. It is refused unless it is one visible line of at most 300 characters with no code fence and no comment opener, and any control, format or separator character, any default-ignorable character, and any space other than U+0020 or a tab is refused, not stripped, so a bare CR, a bidi override, a zero width character, a combining grapheme joiner, a variation selector, a filler, a non-breaking space or U+2028 cannot make the committed bytes differ from what is read; U+2800 is refused by name. The button is offered only on a line the PR adds, and never on a governance file or a protected path, which are the paths `merge` already refuses. By default castellan never pushes it: it is a proposal that anyone with write access to the head branch can apply or ignore.
- **The branch is written only when a repo asks, and only where the write cannot escape.** `fix.pushes` is off by default and `shadow` never writes. Before the first request, the head repository id must equal the base repository id, so a fork or a deleted fork writes nothing; the head branch must not be the base or default branch; and the path must be one this PR changes, is not removing, and no protected path, CODEOWNERS, `.github/` or config rule covers (`planFixes`). `addedLines` reads a `+++ ` header only before the first hunk of a file, so an added line beginning `++ ` cannot name a path. The commit goes through `createCommitOnBranch` with `expectedHeadOid`, which refuses a branch that moved or was reset backwards, and only a tree entry at `100644` or `100755` whose blob is valid UTF-8 is rewritten, so a symlink, a binary and an exec bit are left as they were. The model supplies only the replacement line; it cannot choose the commit, the parent, the mode or the bytes around it.- **The writer is not the judge.** `castellan_written` in `src/rules.ts` escalates any PR with a commit castellan wrote (its login as author or committer, or a `castellan-fix:` trailer) until a human approves the current head, and `act` re-checks the same condition next to `protected_guard` before it approves. A model finding that is committed therefore cannot be merged by the model that wrote it. Writing also stops at 3 castellan commits per PR, so a disagreement cannot become a chain.
- **Inert output.** Model and PR text rendered into comments is stripped of `@` mentions, links, raw URLs, HTML and dashes (`escapeText`), and the state block escapes `<`, `>` and dashes so model text cannot close the comment or forge a marker. Inline review comments go through the same `escapeText`, and a finding is only placed on a `path` and `line` the diff itself shows, so the model cannot aim a comment at an arbitrary line of a file it never saw.
- **Fail closed.** Raw provider errors are kept out of comments.

What remains: a small, in scope PR from an eligible author whose text persuades the model that it matches its issue. The size gate (default `size: fixed`, which escalates over 100 lines, 5 files or 2 top-level dirs; `size: model` replaces those counts with the model's own judgement, and `size: off` removes both), protected paths, the external author rule (a `fix:` linked to a bug labeled issue) and CI limit how much that can be.

## What the budget cap does

- `maxCostUsd` (`LlmDeps` in `src/llm.ts`) is a per call guard: before sending, castellan estimates the input cost as `(system + user characters) / 4` tokens at the model's input price, and a call above the cap fails with `budget`, which escalates. Output tokens are not estimated; `max_tokens` bounds them at 4,096.
- No shipped entrypoint (Lambda, Action, CLI) sets `maxCostUsd`, so this cap is not active today.
- The `budget` failure is also what an unpriced model id produces. That check is always active: only the four default model ids have a price, so any other `models.*` value fails closed.
- Spend is otherwise bounded by design: at most 4 review calls per head SHA and prompt, the first plus the 3 thread-driven re-runs above, all cached, so an unchanged head with stable threads costs nothing; no call for rule escalated PRs in `enforce` unless its only reasons are the size limits and every other rule is clean (`shadow` makes one cached call per head for them too), no retries, a 30 second timeout, and 3 concurrent jobs on the Lambda. A failed model call is never cached, so later `check_suite` events retry it until one succeeds; those retries are not thread-driven and are not counted against the 3.
- The RFC's monthly Bedrock cap ($150 hard stop, alert at $75) is not in this repo. [self-hosting.md](self-hosting.md#infrastructure) places the AWS budget in the infra repo, not in the code. There is no budget env var; the only cost guards are the per-call `maxCostUsd` cap and the alert-only AWS Budget (50% and 100% of $150).
- Triage has no cache, so a `needs-triage` issue costs one model call on every run that reaches it.

## Differences from the RFC

The code is the reference. Where [RFC agent-of-empires#5502](https://github.com/agent-of-empires/agent-of-empires/issues/5502) differs:

- Escalation does request the CODEOWNERS team (or `reviewers.team`). In `enforce` it posts the brief, asks the owning team and `reviewers.users` for a review once per head, and sets the status to `pending`. Shadow requests nobody, because it must not write.
- Shadow mode sets the status to `success` with a "shadow: would merge" or "shadow: would escalate" description for a verdict, and to `pending` with "shadow: waiting for CI" while CI is unsettled. It blocks nothing either way: castellan is not a required check.
- The RFC's "protected and release CODEOWNERS paths" are two config lists (`paths.protected`, `paths.release`) plus files owned by `teams.protected`, not every CODEOWNERS entry.
- The monthly budget is infra, not code (see above); the per call cap exists but is not wired.
- The kill switches are `mode: off` and an empty `CASTELLAN_REPOS`.

GitHub is the only supported provider today. All GitHub access goes through `src/github.ts` (the transport and client) and the `GithubTransport` passed through the pipeline; other providers are tracked in [#35](https://github.com/agent-of-empires/castellan/issues/35).
