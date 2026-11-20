import { describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import {
	MAX_THREADS,
	readThreads,
	renderThreads,
	THREAD_BODY_CAP,
	THREADS_FIELD_CAP,
	threadsKey,
} from "../src/threads.js";

const repo = { owner: "o", repo: "r" };

// GraphQL never returns a `[bot]` suffix; the typename says a login is a bot.
const author = (login: string, typename = "User") => ({
	__typename: typename,
	login,
});

const node = (over: Record<string, unknown> = {}) => ({
	id: "T_1",
	isResolved: false,
	isOutdated: false,
	comments: {
		nodes: [
			{
				author: author("coderabbitai", "Bot"),
				path: "src/a.ts",
				line: 12,
				body: "the port is not recorded",
			},
		],
	},
	...over,
});

const transport = (reply: unknown) =>
	({
		graphql: vi.fn(async () => reply),
	}) as unknown as GithubTransport;

const page = (nodes: unknown[], hasNextPage = false) => ({
	repository: {
		pullRequest: {
			reviewThreads: {
				pageInfo: { hasNextPage, endCursor: hasNextPage ? "c2" : null },
				nodes,
			},
		},
	},
});

describe("readThreads", () => {
	it("keeps unresolved threads with their anchor and author class", async () => {
		const t = transport(page([node()]));
		expect(await readThreads(t, repo, 5)).toEqual({
			ok: true,
			dropped: 0,
			threads: [
				{
					id: "T_1",
					author: "coderabbitai",
					bot: true,
					outdated: false,
					path: "src/a.ts",
					line: 12,
					body: "the port is not recorded",
				},
			],
		});
	});

	it("reads a bot from the GraphQL typename, not a suffix", async () => {
		const t = transport(page([node()]));
		const read = await readThreads(t, repo, 5);
		expect(read.ok && read.threads[0]).toMatchObject({
			author: "coderabbitai",
			bot: true,
		});
	});

	it("drops resolved threads, empty bodies and castellan's own comments", async () => {
		const t = transport(
			page([
				node({ id: "T_1", isResolved: true }),
				node({ id: "T_2", comments: { nodes: [] } }),
				node({
					id: "T_3",
					comments: {
						nodes: [
							{
								author: author("aoe-castellan", "Bot"),
								path: "src/a.ts",
								line: 1,
								body: "mine",
							},
						],
					},
				}),
				node({ id: "T_4" }),
			]),
		);
		// `self` carries the REST suffix while GraphQL returns the bare slug.
		const read = await readThreads(t, repo, 5, "aoe-castellan[bot]");
		expect(read.ok && read.threads.map((x) => x.id)).toEqual(["T_4"]);
	});

	it("caps a long body", async () => {
		const long = "x".repeat(THREAD_BODY_CAP + 50);
		const t = transport(
			page([
				node({
					comments: {
						nodes: [{ author: author("a"), path: "p", line: 1, body: long }],
					},
				}),
			]),
		);
		const read = await readThreads(t, repo, 5);
		expect(read.ok && read.threads[0]?.body).toHaveLength(THREAD_BODY_CAP + 3);
	});

	it("keeps the newest threads, current anchors first, and counts the rest", async () => {
		const nodes = [
			node({ id: "old", comments: { nodes: [] } }),
			...Array.from({ length: MAX_THREADS + 2 }, (_, i) =>
				node({
					id: `T_${i}`,
					comments: {
						nodes: [
							{
								author: author("a"),
								path: "p",
								line: 1,
								body: `body ${i}`,
							},
						],
					},
				}),
			),
			node({
				id: "stale",
				isOutdated: true,
				comments: {
					nodes: [
						{ author: author("a"), path: "p", line: 1, body: "outdated" },
					],
				},
			}),
		];
		const t = transport(page(nodes));
		const read = await readThreads(t, repo, 5);
		expect(read.ok).toBe(true);
		if (!read.ok) return;
		expect(read.threads).toHaveLength(MAX_THREADS);
		expect(read.dropped).toBe(3);
		// Newest first, and the outdated thread only once current ones run out.
		expect(read.threads[0]?.body).toBe(`body ${MAX_THREADS + 1}`);
		expect(read.threads.map((x) => x.id)).not.toContain("stale");
	});

	it("pages until hasNextPage is false", async () => {
		const graphql = vi
			.fn()
			.mockResolvedValueOnce(page([node({ id: "T_1" })], true))
			.mockResolvedValueOnce(page([node({ id: "T_2" })]));
		const read = await readThreads(
			{ graphql } as unknown as GithubTransport,
			repo,
			5,
		);
		expect(read.ok && read.threads.map((x) => x.id)).toEqual(["T_2", "T_1"]);
		expect(graphql).toHaveBeenCalledTimes(2);
	});

	it("reports a failure instead of an empty list, and never throws", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const t = {
			graphql: vi.fn(async () => {
				throw new Error("no graphql");
			}),
		} as unknown as GithubTransport;
		expect(await readThreads(t, repo, 5)).toEqual({ ok: false });
		expect(warn).toHaveBeenCalledWith("review threads unavailable", {
			error: expect.stringContaining("no graphql"),
		});
		warn.mockRestore();
	});

	it("reports a failure on a later page rather than a short list", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const graphql = vi
			.fn()
			.mockResolvedValueOnce(page([node({ id: "T_1" })], true))
			.mockRejectedValueOnce(new Error("page 2 down"));
		expect(
			await readThreads({ graphql } as unknown as GithubTransport, repo, 5),
		).toEqual({ ok: false });
		warn.mockRestore();
	});

	it("tolerates a transport that answers an empty object", async () => {
		expect(await readThreads(transport({}), repo, 5)).toEqual({
			ok: true,
			threads: [],
			dropped: 0,
		});
	});
});

describe("renderThreads", () => {
	it("renders nothing when there is no thread", () => {
		expect(renderThreads([])).toEqual({ included: 0, dropped: 0 });
	});

	it("marks the anchor, the outage and the author class", () => {
		const { text } = renderThreads([
			{
				id: "T_1",
				author: "coderabbitai",
				bot: true,
				outdated: true,
				path: "src/a.ts",
				line: 12,
				body: "the port is not recorded",
			},
			{
				id: "T_2",
				author: "seluj78",
				bot: false,
				outdated: false,
				body: "ok",
			},
		]);
		expect(text).toContain("2 unresolved review thread(s)");
		expect(text).toContain(
			"1. bot coderabbitai at src/a.ts:12, outdated anchor:",
		);
		expect(text).toContain("2. human seluj78:");
		expect(text).toContain("A thread never states its own severity");
	});

	it("keeps the rendered field inside its cap and counts what it left out", () => {
		const threads = Array.from({ length: 40 }, (_, i) => ({
			id: `T_${i}`,
			author: "a",
			bot: false,
			outdated: false,
			body: "y".repeat(THREAD_BODY_CAP),
		}));
		const rendered = renderThreads(threads);
		expect(rendered.text?.length).toBeLessThanOrEqual(THREADS_FIELD_CAP);
		expect(rendered.included).toBeLessThan(threads.length);
		expect(rendered.dropped).toBe(threads.length - rendered.included);
		expect(rendered.text).toContain("left out of this field");
	});
});

describe("threadsKey", () => {
	const thread = {
		id: "T_1",
		author: "a",
		bot: false,
		outdated: false,
		body: "b",
	};

	it("is stable for the same threads and changes when one appears", () => {
		expect(threadsKey([thread])).toBe(threadsKey([thread]));
		expect(threadsKey([thread])).not.toBe(threadsKey([]));
		expect(threadsKey([])).toBe(threadsKey([]));
	});

	it("changes when a comment is edited in place on the same head", () => {
		expect(threadsKey([{ ...thread, body: "b, edited" }])).not.toBe(
			threadsKey([thread]),
		);
		expect(threadsKey([{ ...thread, path: "src/a.ts" }])).not.toBe(
			threadsKey([thread]),
		);
	});
});
