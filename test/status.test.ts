import { describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import {
	findStickyComment,
	setStatus,
	statusFor,
	upsertComment,
} from "../src/status.js";

const repo = { owner: "o", repo: "r" };
const bot = { type: "Bot" };

function fake(comments: unknown[]) {
	const request = vi.fn(async (_route: string, _p?: unknown) => ({ data: {} }));
	const paginate = vi.fn(async () => comments);
	return {
		request,
		transport: { request, paginate } as unknown as GithubTransport,
	};
}

describe("status", () => {
	it("maps merge to success and escalate to pending, never failure", () => {
		expect(statusFor("merge").state).toBe("success");
		expect(statusFor("escalate").state).toBe("pending");
	});

	it("posts the castellan context", async () => {
		const { transport, request } = fake([]);
		await setStatus(transport, repo, "sha1", "merge");
		expect(request).toHaveBeenCalledWith(
			"POST /repos/{owner}/{repo}/statuses/{sha}",
			expect.objectContaining({
				sha: "sha1",
				context: "castellan",
				state: "success",
			}),
		);
	});
});

describe("sticky comment", () => {
	const mine = { id: 7, user: bot, body: "x\n<!-- castellan {} -->" };

	it("finds the bot comment by marker, ignoring humans", async () => {
		const { transport } = fake([
			{ id: 1, user: { type: "User" }, body: "<!-- castellan {} -->" },
			{ id: 2, user: bot, body: "other bot" },
			mine,
		]);
		expect(await findStickyComment(transport, repo, 3)).toEqual({
			id: 7,
			body: mine.body,
		});
	});

	it("edits in place when present", async () => {
		const { transport, request } = fake([mine]);
		await upsertComment(transport, repo, 3, "new");
		expect(request).toHaveBeenCalledTimes(1);
		expect(request).toHaveBeenCalledWith(
			"PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
			expect.objectContaining({ comment_id: 7, body: "new" }),
		);
	});

	it("creates once when absent", async () => {
		const { transport, request } = fake([]);
		await upsertComment(transport, repo, 3, "new");
		expect(request).toHaveBeenCalledWith(
			"POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
			expect.objectContaining({ issue_number: 3, body: "new" }),
		);
	});
});
