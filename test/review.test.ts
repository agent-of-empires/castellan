import { describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import {
	inlineComments,
	MAX_INLINE,
	MAX_SUGGESTION,
	planInline,
	submitReview,
} from "../src/review.js";

const lines = new Map([["src/a.ts", new Set([1, 2, 3])]]);
const repo = { owner: "o", repo: "r" };

describe("planInline", () => {
	const reasons = [
		{ severity: "blocker", text: "a", path: "src/a.ts", line: 2 },
		{ severity: "nit", text: "b" },
		{ severity: "concern", text: "c", path: "src/a.ts", line: 99 },
		{ severity: "concern", text: "d", path: "src/other.ts", line: 1 },
		{ severity: "nit", text: "e", path: "src/a.ts", line: 2 },
	];

	it("keeps only findings on a line the diff shows", () => {
		expect(planInline(reasons, lines)).toEqual([
			{ index: 0, path: "src/a.ts", line: 2 },
		]);
	});

	it("caps the number of inline comments", () => {
		const many = Array.from({ length: MAX_INLINE + 5 }, (_, i) => ({
			severity: "nit",
			text: `t${i}`,
			path: "src/a.ts",
			line: i + 1,
		}));
		const big = new Map([["src/a.ts", new Set(many.map((r) => r.line))]]);
		expect(planInline(many, big)).toHaveLength(MAX_INLINE);
	});

	it("returns nothing without a diff", () => {
		expect(planInline(reasons, new Map())).toEqual([]);
	});
});

describe("inlineComments", () => {
	const reasons = [
		{ severity: "blocker", text: "must fix" },
		{ severity: "nit", text: "prefer @someone and <b>" },
	];
	/** Lines 1 to 3 of each path count as added, and nothing is barred. */
	const scope = (
		barred: (path: string) => boolean = () => false,
		paths = ["p", "src/a.ts"],
	) => ({
		added: new Map(paths.map((p) => [p, new Set([1, 2, 3])])),
		barred,
	});

	it("labels a nit and leaves the rest unlabelled", () => {
		const out = inlineComments(
			[
				{ index: 0, path: "src/a.ts", line: 2 },
				{ index: 1, path: "src/a.ts", line: 3 },
			],
			reasons,
			scope(),
		);
		expect(out).toEqual([
			{ index: 0, path: "src/a.ts", line: 2, body: "must fix" },
			{
				index: 1,
				path: "src/a.ts",
				line: 3,
				body: "nit: prefer someone and &lt;b>",
			},
		]);
	});

	it("offers a one line fix as a suggestion", () => {
		const out = inlineComments(
			[{ index: 0, path: "src/a.ts", line: 2 }],
			[
				{
					severity: "concern",
					text: "guard it",
					suggestion: "if (!x) return;",
				},
			],
			scope(),
		);
		expect(out[0]?.body).toBe(
			"guard it\n\n```suggestion\nif (!x) return;\n```",
		);
	});

	it("keeps the code verbatim, without escaping it", () => {
		const out = inlineComments(
			[{ index: 0, path: "p", line: 1 }],
			[
				{
					severity: "nit",
					text: "mention him",
					suggestion: "// call @bob <b>",
				},
			],
			scope(),
		);
		expect(out[0]?.body).toContain("// call @bob <b>");
	});

	it("drops a suggestion that is not one line of plain code", () => {
		const bodies = [
			"two\nlines",
			"```js",
			"<!-- castellan }",
			"x".repeat(MAX_SUGGESTION + 1),
			"   ",
			// A bare CR is a line ending in CommonMark, so it is refused, not joined.
			"a();\rb();",
			"a();\r\nb();",
			// U+2028 ends a `//` comment in JavaScript, so `evil()` would run.
			"// ok\u2028evil();",
			// Trojan Source: what is rendered differs from what is committed.
			"if (role \u202e=== 'admin'\u2066) {",
			"zero\u200bwidth",
			"nul\u0000byte",
			// Default ignorable: renders as nothing, commits a different identifier.
			'if (role === "admin\u034f") {',
			'if (role === "admin\ufe0f") {',
			"hangul\u3164filler",
			"braille\u2800blank",
			// Any space that is not U+0020: NBSP, figure space, ideographic space.
			"no\u00a0break",
			"figure\u2007space",
			"wide\u3000space",
		].map(
			(suggestion) =>
				inlineComments(
					[{ index: 0, path: "p", line: 1 }],
					[{ severity: "nit", text: "t", suggestion }],
					scope(),
				)[0]?.body,
		);
		for (const body of bodies) expect(body).toBe("nit: t");
	});

	it("keeps a tab, the one control character indentation needs", () => {
		const out = inlineComments(
			[{ index: 0, path: "p", line: 1 }],
			[{ severity: "nit", text: "t", suggestion: "\tif (!x) return;" }],
			scope(),
		);
		expect(out[0]?.body).toContain("```suggestion\n\tif (!x) return;\n```");
	});

	it("keeps the finding but drops the button off an added line", () => {
		const finding = [{ index: 0, path: "p", line: 99 }];
		const out = inlineComments(
			finding,
			[{ severity: "nit", text: "t", suggestion: "x" }],
			scope(),
		);
		expect(out[0]?.body).toBe("nit: t");
	});

	it("keeps the finding but drops the button on a barred path", () => {
		const findings = [
			{ index: 0, path: ".github/workflows/ci.yml", line: 1 },
			{ index: 1, path: "src/a.ts", line: 1 },
		];
		const out = inlineComments(
			findings,
			[
				{ severity: "nit", text: "a", suggestion: "run: make" },
				{ severity: "nit", text: "b", suggestion: "let y = 1;" },
			],
			scope(
				(path) => path.startsWith(".github/"),
				[".github/workflows/ci.yml", "src/a.ts"],
			),
		);
		expect(out[0]?.body).toBe("nit: a");
		expect(out[1]?.body).toContain("```suggestion\nlet y = 1;\n```");
	});

	it("drops a finding the reason list no longer holds", () => {
		expect(
			inlineComments([{ index: 5, path: "p", line: 1 }], reasons, scope()),
		).toEqual([]);
	});
});

describe("submitReview", () => {
	const base = {
		pullNumber: 3,
		headSha: "head1",
		body: "body",
		login: "castellan[bot]",
	};
	const comments = [{ index: 0, path: "src/a.ts", line: 2, body: "fix" }];

	const transport = (reviews: unknown[]) => {
		const request = vi.fn(async () => ({
			data: { html_url: "https://x/r", id: 1 },
		}));
		return {
			request,
			transport: {
				request,
				paginate: vi.fn(async () => reviews),
			} as unknown as GithubTransport,
		};
	};

	it("posts one review with the anchored comments", async () => {
		const { request, transport: t } = transport([]);
		const out = await submitReview(t, repo, {
			...base,
			event: "COMMENT",
			comments,
		});
		expect(out).toEqual({ approved: false, url: "https://x/r" });
		expect(request).toHaveBeenCalledWith(
			"POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
			expect.objectContaining({
				commit_id: "head1",
				event: "COMMENT",
				body: "body",
				comments: [{ path: "src/a.ts", line: 2, body: "fix" }],
			}),
		);
	});

	it("posts the new comments as a second review, since PUT cannot add them", async () => {
		const { request, transport: t } = transport([
			{
				id: 9,
				user: { login: "castellan[bot]" },
				commit_id: "head1",
				state: "COMMENTED",
			},
		]);
		const out = await submitReview(t, repo, {
			...base,
			event: "COMMENT",
			comments,
		});
		expect(request).toHaveBeenCalledWith(
			"POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
			expect.objectContaining({
				commit_id: "head1",
				comments: [{ path: "src/a.ts", line: 2, body: "fix" }],
			}),
		);
		expect(out.approved).toBe(false);
	});

	it("does not rewrite a findings review at this head", async () => {
		const { request, transport: t } = transport([
			{
				id: 9,
				user: { login: "castellan[bot]" },
				commit_id: "head1",
				state: "COMMENTED",
			},
		]);
		await submitReview(t, repo, { ...base, event: "COMMENT", comments });
		// `PUT` would overwrite that review's findings summary, so only an
		// approval at the same head is edited.
		expect(request).not.toHaveBeenCalledWith(
			"PUT /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}",
			expect.anything(),
		);
	});

	it("ignores another author's review at the same head", async () => {
		const { request, transport: t } = transport([
			{
				id: 9,
				user: { login: "someone" },
				commit_id: "head1",
				state: "APPROVED",
			},
		]);
		await submitReview(t, repo, { ...base, event: "COMMENT", comments });
		expect(request).toHaveBeenCalledWith(
			"POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
			expect.anything(),
		);
	});

	it("adds an approving review when only a comment review exists at this head", async () => {
		const { request, transport: t } = transport([
			{
				id: 9,
				user: { login: "castellan[bot]" },
				commit_id: "head1",
				state: "COMMENTED",
			},
		]);
		const out = await submitReview(t, repo, {
			...base,
			event: "APPROVE",
			comments: [],
		});
		expect(out.approved).toBe(true);
		// One call: the approval is posted, and the findings review is left alone.
		expect(request).toHaveBeenCalledTimes(1);
		expect(request).toHaveBeenLastCalledWith(
			"POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
			expect.objectContaining({ event: "APPROVE", commit_id: "head1" }),
		);
	});

	it("does not approve twice when its approval is already at this head", async () => {
		const { request, transport: t } = transport([
			{
				id: 9,
				user: { login: "castellan[bot]" },
				commit_id: "head1",
				state: "APPROVED",
			},
		]);
		const out = await submitReview(t, repo, {
			...base,
			event: "APPROVE",
			comments: [],
		});
		expect(out.approved).toBe(true);
		expect(request).toHaveBeenCalledTimes(1);
	});
});
