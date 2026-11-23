import { describe, expect, it, vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import { RELATED_LIMIT, relatedOpenPrs, SCAN_LIMIT } from "../src/related.js";

const repo = { owner: "o", repo: "r" };

const pr = (number: number, paths: string[], baseRefName = "main") => ({
	number,
	baseRefName,
	files: { nodes: paths.map((path) => ({ path })) },
});

function transport(nodes: unknown[] | Error): GithubTransport {
	return {
		graphql: vi.fn(async () => {
			if (nodes instanceof Error) throw nodes;
			return { repository: { pullRequests: { nodes } } };
		}),
	} as unknown as GithubTransport;
}

describe("relatedOpenPrs", () => {
	it("names the open PRs that change the same path", async () => {
		const t = transport([
			pr(9, ["src/a.ts", "docs/x.md"]),
			pr(10, ["src/z.ts"]),
		]);
		expect(await relatedOpenPrs(t, repo, 3, "main", ["src/a.ts"])).toEqual([
			{ number: 9, overlap: ["src/a.ts"] },
		]);
	});

	it("leaves out a PR on another base, such as a stacked child", async () => {
		const t = transport([
			pr(9, ["src/a.ts"], "feat/this-one"),
			pr(10, ["src/a.ts"], "release/1.0"),
			pr(11, ["src/a.ts"], "main"),
		]);
		expect(await relatedOpenPrs(t, repo, 3, "main", ["src/a.ts"])).toEqual([
			{ number: 11, overlap: ["src/a.ts"] },
		]);
	});

	it("leaves out the PR under review", async () => {
		const t = transport([pr(3, ["src/a.ts"])]);
		expect(await relatedOpenPrs(t, repo, 3, "main", ["src/a.ts"])).toEqual([]);
	});

	it("orders by overlap and stops at the limit", async () => {
		const nodes = Array.from({ length: RELATED_LIMIT + 3 }, (_, i) =>
			pr(100 + i, i === 4 ? ["a.ts", "b.ts"] : ["a.ts"]),
		);
		const out = await relatedOpenPrs(transport(nodes), repo, 3, "main", [
			"a.ts",
			"b.ts",
		]);
		expect(out).toHaveLength(RELATED_LIMIT);
		expect(out[0]).toEqual({
			number: 104,
			overlap: ["a.ts", "b.ts"],
		});
	});

	it("asks for a bounded list, newest first", async () => {
		const t = transport([]);
		await relatedOpenPrs(t, repo, 3, "main", ["a.ts"]);
		const [query, variables] = (
			t.graphql as unknown as ReturnType<typeof vi.fn>
		).mock.calls[0] as [string, { first: number }];
		expect(query).toContain("states: OPEN");
		expect(variables.first).toBe(SCAN_LIMIT);
	});

	it("returns nothing for an unreadable list", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const t = transport(new Error("500"));
		expect(await relatedOpenPrs(t, repo, 3, "main", ["a.ts"])).toEqual([]);
		warn.mockRestore();
	});

	it("returns nothing without paths", async () => {
		const t = transport([]);
		expect(await relatedOpenPrs(t, repo, 3, "main", [])).toEqual([]);
		expect(t.graphql).not.toHaveBeenCalled();
	});
});
