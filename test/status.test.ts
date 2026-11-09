import { describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import {
	findStickyComment,
	setStatus,
	statusFor,
	upsertComment,
} from "../src/status.js";

const repo = { owner: "o", repo: "r" };

const url = "https://github.com/o/r/pull/3#issuecomment-7";

function fake(comments: unknown[]) {
	const request = vi.fn(
		async (_route: string, p?: { comment_id?: number }) => ({
			data: { id: p?.comment_id ?? 99, html_url: url },
		}),
	);
	const paginate = vi.fn(async () => comments);
	return {
		request,
		transport: { request, paginate } as unknown as GithubTransport,
	};
}

describe("status", () => {
	it("enforce maps merge to success and escalate to pending, never failure", () => {
		expect(statusFor("merge", "enforce")).toEqual({
			state: "success",
			description: "castellan: merge",
		});
		expect(statusFor("escalate", "enforce", "r")).toEqual({
			state: "pending",
			description: "castellan: escalated to a human",
		});
	});

	it("shadow is always success and says what would happen", () => {
		expect(statusFor("merge", "shadow")).toEqual({
			state: "success",
			description: "shadow: would merge",
		});
		expect(statusFor("escalate", "shadow", "touches\n a path")).toEqual({
			state: "success",
			description: "shadow: would escalate (touches a path)",
		});
	});

	it("never splits a surrogate pair when truncating", () => {
		const { description } = statusFor(
			"escalate",
			"shadow",
			"\u{1F600}".repeat(200),
		);
		expect(Array.from(description)).toHaveLength(140);
		expect(description).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
	});

	it("keeps the shadow description within GitHub's 140 character limit", () => {
		const { description } = statusFor("escalate", "shadow", "x".repeat(500));
		expect(description).toHaveLength(140);
	});

	it("posts the castellan context linking to the comment", async () => {
		const { transport, request } = fake([]);
		await setStatus(
			transport,
			repo,
			"sha1",
			{ verdict: "merge", reasons: [] },
			"enforce",
			url,
		);
		expect(request).toHaveBeenCalledWith(
			"POST /repos/{owner}/{repo}/statuses/{sha}",
			expect.objectContaining({
				sha: "sha1",
				context: "castellan",
				state: "success",
				target_url: url,
			}),
		);
	});
});

describe("sticky comment", () => {
	const marker = "x\n<!-- castellan {} -->";
	const mine = { id: 7, user: { login: "castellan[bot]" }, body: marker };
	const other = {
		id: 2,
		user: { login: "other[bot]", type: "Bot" },
		body: marker,
	};
	const author = { login: "castellan[bot]" };

	it("matches by login, ignoring humans and other bots", async () => {
		const { transport } = fake([
			{ id: 1, user: { login: "alice", type: "User" }, body: marker },
			other,
			mine,
		]);
		expect(await findStickyComment(transport, repo, 3, author)).toEqual({
			id: 7,
			body: marker,
		});
	});

	it("matches by app id", async () => {
		const { transport } = fake([
			other,
			{ ...other, id: 8, performed_via_github_app: { id: 42 } },
		]);
		expect(
			(await findStickyComment(transport, repo, 3, { appId: 42 }))?.id,
		).toBe(8);
	});

	it("edits in place and returns the link", async () => {
		const { transport, request } = fake([mine]);
		expect(await upsertComment(transport, repo, 3, "new", author)).toEqual({
			id: 7,
			html_url: url,
		});
		expect(request).toHaveBeenCalledTimes(1);
		expect(request).toHaveBeenCalledWith(
			"PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
			expect.objectContaining({ comment_id: 7, body: "new" }),
		);
	});

	it("ignores another bot's marker and creates a new comment", async () => {
		const { transport, request } = fake([other]);
		const res = await upsertComment(transport, repo, 3, "new", author);
		expect(res.html_url).toBe(url);
		expect(request).toHaveBeenCalledWith(
			"POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
			expect.objectContaining({ issue_number: 3, body: "new" }),
		);
		expect(request).toHaveBeenCalledTimes(1);
	});
});
