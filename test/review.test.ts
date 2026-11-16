import { describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import {
	inlineComments,
	MAX_INLINE,
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

	it("labels a nit and leaves the rest unlabelled", () => {
		const out = inlineComments(
			[
				{ index: 0, path: "src/a.ts", line: 2 },
				{ index: 1, path: "src/a.ts", line: 3 },
			],
			reasons,
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

	it("drops a finding the reason list no longer holds", () => {
		expect(inlineComments([{ index: 5, path: "p", line: 1 }], reasons)).toEqual(
			[],
		);
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
