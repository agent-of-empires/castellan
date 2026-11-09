import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	eventFromEnv,
	handleEvent,
	inputsFromEnv,
} from "../src/adapters/action.js";
import { parseMode, resolveAuth } from "../src/adapters/auth.js";
import {
	authFromEnv,
	cli,
	execute,
	parseCli,
	USAGE,
} from "../src/adapters/cli.js";
import type { GithubTransport } from "../src/github.js";
import type { MessagesClient } from "../src/llm.js";
import { dryRun } from "../src/run.js";
import { COMMENT, fake, llm, merge } from "./fake.js";

const repo = { owner: "o", repo: "r" };
const author = { login: "castellan[bot]" };
const ISSUE = "GET /repos/{owner}/{repo}/issues/{issue_number}";

/** Serves a draft PR under `mode: off`, so nothing past the config is reached. */
function offTransport() {
	const request = vi.fn(async (route: string) => {
		if (route === "GET /repos/{owner}/{repo}") {
			return { data: { default_branch: "main" } };
		}
		if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
			return { data: "mode: off" };
		}
		return { data: { title: "t", body: "", labels: [] } };
	});
	const paginate = vi.fn(async () => []);
	const graphql = vi.fn(async () => ({
		repository: {
			issue: { labels: { nodes: [] }, projectItems: { nodes: [] } },
		},
		organization: null,
	}));
	const transport = {
		request,
		paginate,
		graphql,
	} as unknown as GithubTransport;
	return { transport, request };
}

describe("action events", () => {
	it("refuses pull_request_target before touching the network", async () => {
		const f = offTransport();
		await expect(
			handleEvent(
				"pull_request_target",
				{},
				{ transport: f.transport, repo, author },
			),
		).rejects.toThrow(/pull_request_target/);
		expect(f.request).not.toHaveBeenCalled();
	});

	it("runs a same-repo pull_request", async () => {
		const f = fake();
		const m = llm(merge);
		const items = await handleEvent(
			"pull_request",
			{ pull_request: { number: 3, head: { repo: { fork: false } } } },
			{ transport: f.transport, repo, author, llm: m.deps },
		);
		expect(items).toMatchObject([
			{ kind: "pr", number: 3, result: { status: "done" } },
		]);
		expect(f.routes()).toContain(COMMENT);
	});

	it("does no work for a fork pull_request", async () => {
		const f = fake();
		const items = await handleEvent(
			"pull_request",
			{ pull_request: { number: 3, head: { repo: { fork: true } } } },
			{ transport: f.transport, repo, author },
		);
		expect(items).toEqual([]);
		expect(f.request).not.toHaveBeenCalled();
	});

	it("routes issues and rejects unknown events", async () => {
		const f = offTransport();
		const deps = { transport: f.transport, repo, author };
		const items = await handleEvent("issues", { issue: { number: 4 } }, deps);
		expect(items).toMatchObject([{ kind: "issue", number: 4 }]);
		await expect(handleEvent("push", {}, deps)).rejects.toThrow(/unsupported/);
		await expect(handleEvent("pull_request", {}, deps)).rejects.toThrow(
			/number/,
		);
	});

	it("sweeps on schedule", async () => {
		const f = offTransport();
		const items = await handleEvent(
			"schedule",
			{},
			{ transport: f.transport, repo, author },
		);
		expect(items).toEqual([]);
	});
});

describe("action env", () => {
	it("reads INPUT_* and ignores empty ones", () => {
		expect(
			inputsFromEnv({
				INPUT_GITHUB_TOKEN: "t",
				INPUT_APP_ID: "",
				INPUT_MODE: "enforce",
				INPUT_ANTHROPIC_API_KEY: "k",
			}),
		).toEqual({
			auth: { token: "t" },
			mode: "enforce",
			apiKey: "k",
		});
	});

	it("rejects a mode that is not exactly off, shadow or enforce", () => {
		for (const bad of ["Shadow", "enforced", " enforce"]) {
			expect(() => inputsFromEnv({ INPUT_MODE: bad })).toThrow(/mode input/);
		}
		expect(inputsFromEnv({}).mode).toBeUndefined();
	});

	it("reads the event file and repository", () => {
		const path = join(mkdtempSync(join(tmpdir(), "ev-")), "event.json");
		writeFileSync(path, JSON.stringify({ issue: { number: 9 } }));
		expect(
			eventFromEnv({
				GITHUB_REPOSITORY: "o/r",
				GITHUB_EVENT_NAME: "issues",
				GITHUB_EVENT_PATH: path,
			}),
		).toEqual({ name: "issues", payload: { issue: { number: 9 } }, repo });
		expect(() => eventFromEnv({})).toThrow(/GitHub Actions/);
	});
});

describe("auth", () => {
	it("defaults a token to the workflow bot", async () => {
		const a = await resolveAuth({ token: "t" });
		expect(a.author.login).toBe("github-actions[bot]");
	});

	it("rejects partial app credentials and no credentials, naming the env vars", async () => {
		await expect(resolveAuth({ appId: "1", token: "t" })).rejects.toThrow(
			/app auth/,
		);
		await expect(resolveAuth({})).rejects.toThrow(
			/GITHUB_TOKEN, or CASTELLAN_APP_ID/,
		);
	});

	it("parseMode is exact", () => {
		expect(parseMode("off", "x")).toBe("off");
		expect(() => parseMode("OFF", "x")).toThrow(/x must be one of/);
	});
});

describe("cli", () => {
	it("parses repo, number and flags", () => {
		expect(parseCli(["o/r", "12", "--mode", "enforce", "--dry-run"])).toEqual({
			repo,
			number: 12,
			issue: false,
			dryRun: true,
			mode: "enforce",
		});
		expect(parseCli(["o/r", "3", "--issue"]).issue).toBe(true);
	});

	it("rejects bad input", () => {
		expect(() => parseCli(["o", "1"])).toThrow(/usage/);
		expect(() => parseCli(["o/r", "x"])).toThrow(/usage/);
		expect(() => parseCli(["o/r", "1", "--mode", "yolo"])).toThrow(/--mode/);
	});

	it("prints usage and exits 0 on --help or -h, with no credentials", async () => {
		for (const flag of ["--help", "-h"]) {
			const out: string[] = [];
			expect(await cli([flag], {}, (t) => out.push(t))).toBe(0);
			expect(out).toEqual([USAGE]);
		}
	});

	it("discovers credentials from env", () => {
		expect(
			authFromEnv({
				GITHUB_TOKEN: "t",
				CASTELLAN_APP_ID: "1",
				CASTELLAN_INSTALLATION_ID: "2",
				CASTELLAN_PRIVATE_KEY: "k",
				CASTELLAN_BOT_LOGIN: "me[bot]",
			}),
		).toEqual({
			token: "t",
			appId: "1",
			installationId: "2",
			privateKey: "k",
			botLogin: "me[bot]",
		});
	});

	it("fails without credentials after parsing", async () => {
		await expect(cli(["o/r", "1"], {})).rejects.toThrow(/GITHUB_TOKEN/);
	});

	it("--dry-run on a PR prints the brief and writes nothing, even with --mode enforce", async () => {
		const f = fake();
		const out: string[] = [];
		const code = await execute(
			{ repo, number: 3, issue: false, dryRun: true, mode: "enforce" },
			{ transport: f.transport, author, llm: llm(merge).deps },
			(t) => out.push(t),
		);
		expect(code).toBe(0);
		expect(out.join("\n")).toContain("Castellan brief");
		expect(f.routes().filter((r) => !r.startsWith("GET "))).toEqual([]);
		expect(f.graphql).not.toHaveBeenCalled();
	});
});

describe("dry run guard", () => {
	const answer = {
		priority: "P1",
		area: "area:core",
		type: "bug",
		size: "M",
		readyForAgent: { suggest: false, reason: "" },
		reasons: { priority: "p", area: "a", type: "t", size: "s" },
	};
	const field = (id: string, name: string, options: string[]) => ({
		id,
		name,
		options: options.map((o) => ({ id: `${id}:${o}`, name: o })),
	});

	/** A needs-triage issue whose project has every field, so enforce would write. */
	function triageWorld() {
		const queries: string[] = [];
		const graphql = vi.fn(async (q: string) => {
			queries.push(q);
			if (q.includes("pageInfo")) {
				return {
					repository: {
						labels: {
							nodes: ["P1", "area:core", "bug"].map((name) => ({ name })),
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				};
			}
			return {
				repository: {
					issue: {
						id: "ISSUE",
						labels: { nodes: [{ name: "needs-triage" }] },
						projectItems: { nodes: [] },
					},
				},
				organization: {
					projectsV2: {
						nodes: [
							{
								id: "PRJ",
								title: "Agent of Empires",
								fields: {
									nodes: [
										field("fs", "Status", ["Ready", "Backlog"]),
										field("fp", "Priority", ["P0", "P1", "P2", "P3"]),
										field("fz", "Size", ["XS", "S", "M", "L", "XL"]),
									],
								},
							},
						],
					},
				},
			};
		});
		const request = vi.fn(async (route: string) => {
			if (route === "GET /repos/{owner}/{repo}") {
				return { data: { default_branch: "main" } };
			}
			if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
				return { data: "mode: enforce" };
			}
			if (route === ISSUE) return { data: { title: "t", body: "b" } };
			return { data: {} };
		});
		const transport = {
			request,
			graphql,
			paginate: vi.fn(),
		} as unknown as GithubTransport;
		const client = {
			messages: {
				create: async () => ({
					content: [{ type: "text", text: JSON.stringify(answer) }],
					usage: { input_tokens: 1, output_tokens: 1 },
				}),
			},
		} as unknown as MessagesClient;
		return { transport, request, queries, client };
	}

	it("--issue --dry-run against an enforce config sends no mutation and no write", async () => {
		const w = triageWorld();
		const out: string[] = [];
		const code = await execute(
			{ repo, number: 7, issue: true, dryRun: true },
			{ transport: w.transport, author, llm: { client: w.client } },
			(t) => out.push(t),
		);
		expect(code).toBe(0);
		expect(w.queries.length).toBeGreaterThan(0);
		expect(w.queries.some((q) => /^\s*mutation\b/.test(q))).toBe(false);
		expect(
			w.request.mock.calls.some((c) => !String(c[0]).startsWith("GET ")),
		).toBe(false);
		expect(out.join("\n")).toContain("Castellan triage (shadow)");
	});

	it("refuses a GraphQL mutation outright and passes queries through", async () => {
		const w = triageWorld();
		const { transport } = dryRun(
			{ transport: w.transport, repo, author },
			() => {},
		);
		expect(() => transport.graphql("mutation { x }")).toThrow(/refuses/);
		expect(() => transport.graphql("  \n mutation($a: ID!) { x }")).toThrow(
			/refuses/,
		);
		await transport.graphql("query { x }");
		expect(w.queries).toEqual(["query { x }"]);
	});
});
