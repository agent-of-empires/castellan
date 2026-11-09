# Eval

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
