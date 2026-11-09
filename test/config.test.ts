import { describe, expect, it, vi } from "vitest";
import { githubReader, loadConfig } from "../src/config.js";
import type { GithubTransport } from "../src/github.js";

const reader = (text: string | null) => async () => text;

describe("loadConfig", () => {
	it("parses a full file", async () => {
		const r = await loadConfig(
			"main",
			reader(`
mode: enforce
limits: { maxLines: 50, maxFiles: 3, maxTopLevelDirs: 1 }
paths: { protected: ["src/auth/**"], release: [".github/**"] }
teams: { maintainers: org/maint, protected: org/sec }
trustedAuthors: [klubrake]
skip_branches: ["wip/*"]
labels: { needsTriage: triage, bug: defect }
project: { statusField: S, priorityField: P, sizeField: Z, roadmapField: R }
llm: { provider: anthropic }
models: { review: m1, triage: m2 }
prompt: { base: be strict, guidance: ["no em dashes"] }
`),
		);
		expect(r).toMatchObject({
			ok: true,
			config: {
				mode: "enforce",
				limits: { maxLines: 50 },
				trustedAuthors: ["klubrake"],
				skip_branches: ["wip/*"],
				prompt: { guidance: ["no em dashes"] },
			},
		});
	});

	it("fills defaults for a partial file", async () => {
		const r = await loadConfig(
			"main",
			reader("trustedAuthors: [a]\nlimits: { maxFiles: 2 }"),
		);
		expect(r).toMatchObject({
			ok: true,
			config: {
				mode: "shadow",
				limits: { maxLines: 100, maxFiles: 2, maxTopLevelDirs: 2 },
				labels: { bug: "bug" },
				trustedAuthors: ["a"],
				skip_branches: ["release-staging/*", "release-plz-*"],
			},
		});
	});

	it.each([null, "", "# nothing"])("uses defaults for %j", async (text) => {
		const r = await loadConfig("main", reader(text));
		expect(r).toMatchObject({ ok: true, config: { mode: "shadow" } });
	});

	it.each([
		["bad enum", "mode: yolo"],
		["bad type", "limits: { maxLines: lots }"],
		["unknown key", "mod: off"],
		["not a mapping", "- a\n- b"],
		["bad yaml", "a: [unclosed"],
	])("fails closed on %s", async (_name, text) => {
		const r = await loadConfig("main", reader(text));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain(".castellan.yml");
	});

	it("fails closed when the read throws", async () => {
		const r = await loadConfig("main", async () => {
			throw new Error("boom");
		});
		expect(r).toMatchObject({ ok: false });
	});

	it("reads from the base ref only", async () => {
		const calls: string[][] = [];
		await loadConfig("base-sha", async (ref, path) => {
			calls.push([ref, path]);
			return null;
		});
		expect(calls).toEqual([["base-sha", ".castellan.yml"]]);
	});
});

describe("githubReader", () => {
	const repo = { owner: "agent-of-empires", repo: "castellan" };
	const transport = (request: unknown) =>
		({ request }) as unknown as GithubTransport;

	it("requests the file at the given base sha", async () => {
		const request = vi.fn().mockResolvedValue({ data: "mode: off" });
		const text = await githubReader(transport(request), repo)(
			"abc123",
			".castellan.yml",
		);
		expect(text).toBe("mode: off");
		expect(request).toHaveBeenCalledWith(
			"GET /repos/{owner}/{repo}/contents/{path}",
			expect.objectContaining({
				...repo,
				path: ".castellan.yml",
				ref: "abc123",
			}),
		);
	});

	it("yields defaults on 404", async () => {
		const request = vi.fn().mockRejectedValue({ status: 404 });
		const r = await loadConfig(
			"abc123",
			githubReader(transport(request), repo),
		);
		expect(r).toMatchObject({ ok: true, config: { mode: "shadow" } });
	});

	it("fails closed on 500", async () => {
		const request = vi.fn().mockRejectedValue({ status: 500 });
		const read = githubReader(transport(request), repo);
		await expect(read("abc123", ".castellan.yml")).rejects.toEqual({
			status: 500,
		});
		expect(await loadConfig("abc123", read)).toMatchObject({ ok: false });
	});
});

describe("llm and models", () => {
	const load = (yaml: string) => loadConfig("main", reader(yaml));

	it("defaults to bedrock with bedrock model ids", async () => {
		expect(await load("")).toMatchObject({
			ok: true,
			config: {
				llm: { provider: "bedrock" },
				models: {
					review: "us.anthropic.claude-sonnet-5-5",
					triage: "us.anthropic.claude-haiku-5-5",
				},
			},
		});
	});

	it("defaults to plain ids for the anthropic provider", async () => {
		expect(await load("llm: { provider: anthropic }")).toMatchObject({
			ok: true,
			config: {
				models: { review: "claude-sonnet-5-5", triage: "claude-haiku-5-5" },
			},
		});
	});

	it("keeps an explicit model and defaults the other", async () => {
		expect(await load("models: { review: global.anthropic.x }")).toMatchObject({
			ok: true,
			config: {
				models: {
					review: "global.anthropic.x",
					triage: "us.anthropic.claude-haiku-5-5",
				},
			},
		});
	});

	it("rejects a non-bedrock id for the bedrock provider", async () => {
		const r = await load("models: { review: claude-sonnet-5-5 }");
		expect(r).toMatchObject({ ok: false });
		expect(r.ok === false && r.error).toContain("models.review");
	});

	it("rejects an unknown provider", async () => {
		expect(await load("llm: { provider: openai }")).toMatchObject({
			ok: false,
		});
	});
});
