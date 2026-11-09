import { describe, expect, it } from "vitest";
import { parseBlock } from "../src/cache.js";
import { type Brief, escapeText, renderComment } from "../src/comment.js";
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

	it("lists every check run", () => {
		const out = renderComment(brief);
		expect(out).toContain("| lint | success |");
		expect(out).toContain("| e2e \\| slow | skipped |");
	});
});

describe("escapeText", () => {
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
