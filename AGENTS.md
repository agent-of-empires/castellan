# AGENTS.md

Castellan is a stateless merge gate and issue triage bot for GitHub. Rules decide;
models can only veto a `merge`, never grant one. Design: https://github.com/agent-of-empires/agent-of-empires/issues/5502

## Commands

```bash
pnpm install
pnpm lint        # biome check
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
pnpm build       # esbuild bundle to dist/lambda/index.mjs
```

Run all four before pushing. CI runs the same.

## Conventions

- Do not use em dashes or `--` as prose separators in code, comments, docs, commits, or PR text.
- Conventional commits: `<type>(<scope>): <imperative lowercase subject>`, with type one of `feat`, `fix`, `refactor`, `docs`, `test`, `chore`.
- Every PR and issue body starts with an AI disclosure. PRs also fill the `AI Usage` section of the template.
- Update docs in the same change that alters behavior. Delete or fix stale docs when you make them stale.
- Keep comments short; add one only for a non-obvious reason or invariant.
- Do not add dead code, speculative abstractions, or dependencies a few lines can replace.
- Bug fixes ship with a test that fails before the fix and passes after.
- Issues live in GitHub Issues for `agent-of-empires/castellan`; use `gh`.
