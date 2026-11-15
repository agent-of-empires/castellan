import { describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import {
	MAX_THREADS,
	readThreads,
	renderThreads,
	THREAD_BODY_CAP,
	threadsKey,
} from "../src/threads.js";

const repo = { owner: "o", repo: "r" };

const node = (over: Record<string, unknown> = {}) => ({
	id: "T_1",
	isResolved: false,
	isOutdated: false,
	comments: {
		nodes: [
			{
				author: { login: "coderabbitai[bot]" },
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
		expect(await readThreads(t, repo, 5)).toEqual([
			{
				id: "T_1",
				author: "coderabbitai[bot]",
				bot: true,
				outdated: false,
				path: "src/a.ts",
				line: 12,
				body: "the port is not recorded",
			},
		]);
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
								author: { login: "castellan[bot]" },
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
		const threads = await readThreads(t, repo, 5, "castellan[bot]");
		expect(threads.map((x) => x.id)).toEqual(["T_4"]);
	});

	it("caps a long body and the number of threads", async () => {
		const long = "x".repeat(THREAD_BODY_CAP + 50);
		const t = transport(
			page([
				node({
					comments: {
						nodes: [{ author: { login: "a" }, path: "p", line: 1, body: long }],
					},
				}),
				...Array.from({ length: MAX_THREADS }, (_, i) =>
					node({ id: `T_${i + 9}` }),
				),
			]),
		);
		const threads = await readThreads(t, repo, 5);
		expect(threads).toHaveLength(MAX_THREADS);
		expect(threads[0]?.body).toHaveLength(THREAD_BODY_CAP + 3);
	});

	it("pages until hasNextPage is false", async () => {
		const graphql = vi
			.fn()
			.mockResolvedValueOnce(page([node({ id: "T_1" })], true))
			.mockResolvedValueOnce(page([node({ id: "T_2" })]));
		const threads = await readThreads(
			{ graphql } as unknown as GithubTransport,
			repo,
			5,
		);
		expect(threads.map((x) => x.id)).toEqual(["T_1", "T_2"]);
		expect(graphql).toHaveBeenCalledTimes(2);
	});

	it("returns an empty list when GraphQL fails, and never throws", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const t = {
			graphql: vi.fn(async () => {
				throw new Error("no graphql");
			}),
		} as unknown as GithubTransport;
		expect(await readThreads(t, repo, 5)).toEqual([]);
		expect(warn).toHaveBeenCalledWith("review threads unavailable", {
			error: expect.stringContaining("no graphql"),
		});
		warn.mockRestore();
	});

	it("tolerates a transport that answers an empty object", async () => {
		expect(await readThreads(transport({}), repo, 5)).toEqual([]);
	});
});

describe("renderThreads", () => {
	it("renders nothing when there is no thread", () => {
		expect(renderThreads([])).toBeUndefined();
	});

	it("marks the anchor, the outage and the author class", () => {
		const text = renderThreads([
			{
				id: "T_1",
				author: "coderabbitai[bot]",
				bot: true,
				outdated: true,
				path: "src/a.ts",
				line: 12,
				body: "the port is not recorded",
			},
			{ id: "T_2", author: "seluj78", bot: false, outdated: false, body: "ok" },
		]);
		expect(text).toContain("2 unresolved review thread(s)");
		expect(text).toContain(
			"1. bot coderabbitai[bot] at src/a.ts:12, outdated anchor:",
		);
		expect(text).toContain("2. human seluj78:");
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
});
