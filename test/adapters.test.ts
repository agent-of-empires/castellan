import { describe, expect, it, vi } from "vitest";
import { handleEvent } from "../src/adapters/action.js";
import { resolveAuth } from "../src/adapters/auth.js";
import { execute, parseCli } from "../src/adapters/cli.js";
import type { GithubTransport } from "../src/github.js";

const repo = { owner: "o", repo: "r" };
const author = { login: "castellan[bot]" };

/** Every request 404s, so config loads as defaults and a draft PR is the only thing served. */
function offTransport() {
	const request = vi.fn(async (route: string) => {
		if (route === "GET /repos/{owner}/{repo}") {
			return { data: { default_branch: "main" } };
		}
		if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
			return { data: "mode: off" };
		}
		if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
			return {
				data: {
					user: { login: "a", type: "User" },
					base: { sha: "b" },
				},
			};
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
	return { transport, request, paginate };
}

describe("action", () => {
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

describe("auth", () => {
	it("defaults a token to the workflow bot", async () => {
		const a = await resolveAuth({ token: "t" });
		expect(a.author.login).toBe("github-actions[bot]");
	});

	it("rejects partial app credentials and no credentials", async () => {
		await expect(resolveAuth({ appId: "1", token: "t" })).rejects.toThrow(
			/app auth/,
		);
		await expect(resolveAuth({})).rejects.toThrow(/token/);
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

	it("runs an issue and exits 0 when triage is skipped", async () => {
		const f = offTransport();
		const out: string[] = [];
		const code = await execute(
			{ repo, number: 4, issue: true, dryRun: true },
			{ transport: f.transport, author },
			(t) => out.push(t),
		);
		expect(code).toBe(0);
		expect(out.join("")).toContain('"triaged"');
		expect(
			f.request.mock.calls.every((c) => String(c[0]).startsWith("GET ")),
		).toBe(true);
	});
});
