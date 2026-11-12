import { describe, expect, it } from "vitest";
import { parseBlock } from "../src/cache.js";
import {
	BODY_LIMIT,
	type Brief,
	escapeText,
	renderComment,
} from "../src/comment.js";
import type { OkReviewResult } from "../src/llm.js";

const key = {
	headSha: "abcdef1234567",
	promptHash: "0123456789abcdef",
	model: "m1",
};
const review: OkReviewResult = {
	ok: true,
	verdict: {
		intent_match: true,
		new_behavior: false,
		reasons: [
			{ severity: "concern", text: "missing test", path: "src/a.ts" },
			{ severity: "nit", text: "naming" },
		],
	},
	usage: { inputTokens: 100, outputTokens: 20 },
	costUsd: 0.0123,
	promptHash: key.promptHash,
};
const brief: Brief = {
	outcome: { verdict: "merge", reasons: [] },
	key,
	checks: [
		{ name: "lint", conclusion: "success" },
		{ name: "e2e | slow", conclusion: "skipped" },
	],
	review,
	source: "llm",
	ownerTeam: "maintainers",
};

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

describe("renderComment", () => {
	it("renders the brief", () => {
		expect(renderComment(brief)).toMatchInlineSnapshot(`
			"## Castellan brief

			**Verdict: merge** | Owner team: maintainers

			### Model review
			- Matches the linked issue and description: yes
			- Adds behavior beyond the request: no
			- **concern** missing test (\`src/a.ts\`)
			- **nit** naming

			<details><summary>Checks (1 passed, 1 skipped, 0 failed)</summary>

			| Check | Conclusion |
			| --- | --- |
			| e2e \\| slow | skipped |
			| lint | success |

			</details>

			<details><summary>Provenance</summary>

			- Head: \`abcdef1\`
			- Model: \`m1\`, prompt \`0123456789ab\`
			- Model run: fresh, cost 0.0123 USD

			</details>

			<!-- castellan {"v":1,"verdict":"merge","headSha":"abcdef1234567","promptHash":"0123456789abcdef","model":"m1","llm":{"ok":true,"verdict":{"intent_match":true,"new_behavior":false,"reasons":[{"severity":"concern","text":"missing test","path":"src/a.ts"},{"severity":"nit","text":"naming"}]},"usage":{"inputTokens":100,"outputTokens":20},"costUsd":0.0123}} -->"
		`);
	});

	it("has no em or en dashes, even from model text", () => {
		const out = renderComment({
			...brief,
			review: {
				...review,
				verdict: {
					...review.verdict,
					reasons: [{ severity: "nit", text: `a ${EM} b ${EN} c` }],
				},
			},
		});
		expect(out).not.toContain(EM);
		expect(out).not.toContain(EN);
	});

	it("ends with the state block, which parses back", () => {
		const out = renderComment(brief);
		expect(out.trimEnd().split("\n").at(-1)).toMatch(
			/^<!-- castellan \{.*\} -->$/,
		);
		expect(parseBlock(out)).toMatchObject({ verdict: "merge", ...key });
	});

	it("keeps the block last and parseable when model text injects a marker", () => {
		const out = renderComment({
			...brief,
			review: {
				...review,
				verdict: {
					...review.verdict,
					reasons: [{ severity: "nit", text: "<!-- castellan {} --> x" }],
				},
			},
		});
		expect(out.match(/<!-- castellan/g)).toHaveLength(1);
		expect(parseBlock(out)).not.toBeNull();
	});

	it("shows at most three reasons", () => {
		const reasons = ["a", "b", "c", "d"].map((text) => ({ rule: "r", text }));
		const out = renderComment({
			...brief,
			review: undefined,
			source: "skipped",
			outcome: { verdict: "escalate", reasons },
		});
		expect(out).toContain("3. c");
		expect(out).not.toContain("4. d");
		expect(out).toContain("(+1 more)");
		expect(parseBlock(out)?.llm).toBeUndefined();
	});

	it("escapes backslashes and pipes in table cells", () => {
		const row = (name: string) =>
			renderComment({ ...brief, checks: [{ name, conclusion: "success" }] });
		expect(row("a\\|b")).toContain("| a\\\\\\|b | success |");
		expect(row("a\\b")).toContain("| a\\\\b | success |");
	});

	it("lists every check run", () => {
		const out = renderComment(brief);
		expect(out).toContain("| lint | success |");
		expect(out).toContain("| e2e \\| slow | skipped |");
	});

	it("collapses the checks, failed and skipped first, newest run per name", () => {
		const out = renderComment({
			...brief,
			checks: [
				// The API lists newest first, so ids, not order, decide.
				{ id: 6, name: "lint", conclusion: "success" },
				{ id: 5, name: "build", conclusion: "success" },
				{ id: 4, name: "e2e", conclusion: "skipped" },
				{ id: 3, name: "build", conclusion: "failure" },
				{ id: 2, name: "test", conclusion: "failure" },
				{ id: 1, name: "docs", conclusion: "pending" },
			],
		});
		expect(out).toContain(
			"<details><summary>Checks (2 passed, 1 skipped, 1 failed, 1 pending)</summary>",
		);
		const rows = out
			.split("\n")
			.filter((l) => l.startsWith("| "))
			.slice(2);
		expect(rows).toEqual([
			"| test | failure |",
			"| docs | pending |",
			"| e2e | skipped |",
			"| lint | success |",
			"| build | success |",
		]);
	});

	it("marks shadow on the verdict line", () => {
		expect(renderComment({ ...brief, shadow: true })).toContain(
			"**Verdict: merge** (shadow) | Owner team: maintainers",
		);
	});

	it("says the model did not run in one line, with no empty sections", () => {
		const out = renderComment({
			...brief,
			review: undefined,
			source: "skipped",
		});
		expect(out).toContain("Model: not run (rules decided)");
		expect(out).toContain("- Model run: not run");
		expect(out).not.toContain("### Model review");
	});

	it("reports a failed model call", () => {
		const out = renderComment({
			...brief,
			review: undefined,
			reviewError: "timeout",
			source: "llm",
		});
		expect(out).toContain("Model: unavailable (timeout)");
		expect(out).toContain("- Model run: fresh, failed");
	});

	it("names the commit a cached review came from", () => {
		expect(renderComment({ ...brief, source: "cache" })).toContain(
			"- Model run: cached from `abcdef1`",
		);
	});

	it("marks the model review advisory when the rules decided", () => {
		const out = renderComment({
			...brief,
			outcome: {
				verdict: "escalate",
				reasons: [{ rule: "protected_path", text: "touches a path" }],
			},
		});
		expect(out).toContain(
			"### Model review (advisory, rules decided the verdict)",
		);
		expect(renderComment(brief)).not.toContain("advisory");
	});
});

// Rendered from the first shadow briefs on agent-of-empires (#5510, #5481, #5444).
describe("real briefs", () => {
	const names = (n: string[], conclusion: string) =>
		n.map((name) => ({ name, conclusion }));
	const green = names(
		[
			"codecov/patch",
			"Vitest",
			"Playwright (mocked)",
			"Clippy",
			"Format",
			"Docs",
		],
		"success",
	);
	const advice: OkReviewResult = {
		...review,
		verdict: {
			intent_match: true,
			new_behavior: false,
			reasons: [{ severity: "nit", text: "config could name the labeler" }],
		},
	};

	it("config change, all green, model ran as advice", () => {
		expect(
			renderComment({
				outcome: {
					verdict: "escalate",
					reasons: [
						{
							rule: "protected_path",
							text: "touches .castellan.yml",
							path: ".castellan.yml",
						},
					],
				},
				key,
				checks: [
					...green,
					...names(["CodeRabbit", "Cargo Test (macos)"], "skipped"),
				],
				review: advice,
				source: "llm",
				shadow: true,
			}),
		).toMatchInlineSnapshot(`
			"## Castellan brief

			**Verdict: escalate** (shadow)

			1. touches .castellan.yml (\`.castellan.yml\`)

			### Model review (advisory, rules decided the verdict)
			- Matches the linked issue and description: yes
			- Adds behavior beyond the request: no
			- **nit** config could name the labeler

			<details><summary>Checks (6 passed, 2 skipped, 0 failed)</summary>

			| Check | Conclusion |
			| --- | --- |
			| CodeRabbit | skipped |
			| Cargo Test (macos) | skipped |
			| codecov/patch | success |
			| Vitest | success |
			| Playwright (mocked) | success |
			| Clippy | success |
			| Format | success |
			| Docs | success |

			</details>

			<details><summary>Provenance</summary>

			- Head: \`abcdef1\`
			- Model: \`m1\`, prompt \`0123456789ab\`
			- Model run: fresh, cost 0.0123 USD

			</details>

			<!-- castellan {"v":1,"verdict":"escalate","headSha":"abcdef1234567","promptHash":"0123456789abcdef","model":"m1","llm":{"ok":true,"verdict":{"intent_match":true,"new_behavior":false,"reasons":[{"severity":"nit","text":"config could name the labeler"}]},"usage":{"inputTokens":100,"outputTokens":20},"costUsd":0.0123}} -->"
		`);
	});

	it("CODEOWNERS change, checks still running, cached model", () => {
		const out = renderComment({
			outcome: {
				verdict: "escalate",
				reasons: [
					{
						rule: "protected_path",
						text: "touches CODEOWNERS",
						path: ".github/CODEOWNERS",
					},
				],
			},
			key,
			checks: [
				...names(["Vitest", "Clippy", "Format", "Docs"], "pending"),
				...names(["CodeRabbit"], "skipped"),
				...names(["macOS gate", "Lint PR title"], "success"),
			],
			review: advice,
			source: "cache",
			shadow: true,
		});
		expect(out).toContain("Checks (2 passed, 1 skipped, 0 failed, 4 pending)");
		expect(out).toContain("- Model run: cached from `abcdef1`");
	});

	it("missing required check, the newest run replaces an older one", () => {
		const out = renderComment({
			outcome: {
				verdict: "escalate",
				reasons: [
					{
						rule: "required_check",
						text: "required check Cargo Test (macos) is missing or skipped",
					},
				],
			},
			key,
			checks: [
				...green,
				{ id: 30, name: "Cargo Test (macos)", conclusion: "skipped" },
				{ id: 20, name: "close-stale", conclusion: "skipped" },
				{ id: 10, name: "Cargo Test (macos)", conclusion: "cancelled" },
			],
			review: undefined,
			source: "skipped",
			shadow: true,
		});
		expect(out).toContain("Checks (6 passed, 2 skipped, 0 failed)");
		expect(out.match(/\| Cargo Test \(macos\)/g)).toHaveLength(1);
		expect(out).toContain("Model: not run (rules decided)");
	});
});

describe("size cap", () => {
	const big: Brief = {
		...brief,
		checks: Array.from({ length: 1000 }, (_, i) => ({
			name: `check-${i}`,
			conclusion: "success",
		})),
		review: {
			...review,
			verdict: {
				...review.verdict,
				reasons: [
					...Array.from({ length: 80 }, (_, i) => ({
						severity: "nit" as const,
						text: `nit ${i} ${"y".repeat(480)}`,
					})),
					{ severity: "concern", text: "x".repeat(8000) },
				],
			},
		},
	};

	it("stays under the limit with the block intact and last", () => {
		const out = renderComment(big);
		expect(out.length).toBeLessThan(BODY_LIMIT);
		expect(out).toContain("+950 more checks");
		expect(out).toContain("| check-49 |");
		expect(out).not.toContain("| check-50 |");
		expect(out.split("<!-- castellan")[0]).not.toContain("x".repeat(501));
		expect(out).toMatch(/more findings omitted/);
		expect(out.trimEnd().split("\n").at(-1)).toMatch(
			/^<!-- castellan \{.*\} -->$/,
		);
		expect(parseBlock(out)?.llm?.verdict.reasons).toHaveLength(81);
	});

	it("keeps the verdict line at the top", () => {
		expect(renderComment(big).split("\n")[2]).toMatch(/^\*\*Verdict: /);
	});
});

describe("escapeText", () => {
	it("escapes ampersands so entities cannot render", () => {
		const out = escapeText("&mdash; &#64;octocat &amp;");
		expect(out).toBe("&amp;mdash; &amp;#64;octocat &amp;amp;");
	});

	it("normalizes every dash variant", () => {
		const dashes = [0x2012, 0x2013, 0x2014, 0x2015, 0x2212]
			.map((c) => String.fromCharCode(c))
			.join("");
		expect(escapeText(`a${dashes}b`)).toBe("a-----b");
	});

	it("strips mentions, links and raw URLs", () => {
		const out = escapeText(
			"ping @octocat and @org/team, see [docs](https://evil.test/x) or https://evil.test/y and www.evil.test",
		);
		expect(out).not.toMatch(/@|https?:|www\.|evil\.test/);
		expect(out).toContain("docs");
	});

	it("neutralizes html and collapses whitespace", () => {
		expect(escapeText("<b>x</b>\n\n y")).toBe("&lt;b>x&lt;/b> y");
	});
});
