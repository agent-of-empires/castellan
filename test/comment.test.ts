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

			### Conformance
			- Matches the linked issue and description: yes
			- Adds behavior beyond the request: no

			### Correctness
			- [ ] **concern** missing test (\`src/a.ts\`)
			- [ ] **nit** naming

			### Evidence
			| Check | Conclusion |
			| --- | --- |
			| lint | success |
			| e2e \\| slow | skipped |

			### Provenance
			- Head: \`abcdef1\`
			- Model: \`m1\`, prompt \`0123456789ab\`
			- Source: llm, cost 0.0123 USD

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
