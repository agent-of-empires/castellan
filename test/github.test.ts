import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	createGithubClient,
	type GithubTransport,
	installationTransport,
} from "../src/github.js";

const repo = { owner: "agent-of-empires", repo: "castellan" };

function fake(request: unknown, graphql: unknown = vi.fn()): GithubTransport {
	return { request, graphql } as unknown as GithubTransport;
}

describe("requiredChecks", () => {
	it("merges and dedupes required contexts across rulesets", async () => {
		const request = vi.fn().mockResolvedValue({
			data: [
				{ type: "pull_request", parameters: {} },
				{
					type: "required_status_checks",
					parameters: {
						required_status_checks: [{ context: "lint" }, { context: "test" }],
					},
				},
				{
					type: "required_status_checks",
					parameters: { required_status_checks: [{ context: "test" }] },
				},
			],
		});
		const client = createGithubClient(fake(request), repo);
		expect(await client.requiredChecks("main")).toEqual(["lint", "test"]);
		expect(request).toHaveBeenCalledWith(
			"GET /repos/{owner}/{repo}/rules/branches/{branch}",
			expect.objectContaining({ ...repo, branch: "main" }),
		);
	});

	it("returns an empty list when no check is required", async () => {
		const request = vi.fn().mockResolvedValue({ data: [] });
		const client = createGithubClient(fake(request), repo);
		expect(await client.requiredChecks("main")).toEqual([]);
	});
});

describe("isTeamMember", () => {
	const member = (request: unknown) =>
		createGithubClient(fake(request), repo).isTeamMember(
			"agent-of-empires",
			"maintainers",
			"alice",
		);

	it("is true for an active membership", async () => {
		const request = vi.fn().mockResolvedValue({ data: { state: "active" } });
		expect(await member(request)).toBe(true);
		expect(request).toHaveBeenCalledWith(
			"GET /orgs/{org}/teams/{team_slug}/memberships/{username}",
			{ org: "agent-of-empires", team_slug: "maintainers", username: "alice" },
		);
	});

	it("is false for a pending invitation", async () => {
		const request = vi.fn().mockResolvedValue({ data: { state: "pending" } });
		expect(await member(request)).toBe(false);
	});

	it("is false on 404", async () => {
		const request = vi.fn().mockRejectedValue({ status: 404 });
		expect(await member(request)).toBe(false);
	});

	it("rethrows other errors so the caller escalates", async () => {
		const request = vi.fn().mockRejectedValue({ status: 500 });
		await expect(member(request)).rejects.toEqual({ status: 500 });
	});
});

describe("graphql", () => {
	it("forwards query and variables", async () => {
		const graphql = vi.fn().mockResolvedValue({ ok: true });
		const client = createGithubClient(fake(vi.fn(), graphql), repo);
		expect(await client.graphql("query { x }", { a: 1 })).toEqual({ ok: true });
		expect(graphql).toHaveBeenCalledWith("query { x }", { a: 1 });
	});
});

describe("installationTransport", () => {
	it("mints one installation token and reuses it", async () => {
		const { privateKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
			privateKeyEncoding: { type: "pkcs8", format: "pem" },
			publicKeyEncoding: { type: "spki", format: "pem" },
		});
		const calls: { url: string; auth: string | null }[] = [];
		const fetchMock = vi.fn(
			async (input: Request | string | URL, init?: RequestInit) => {
				const url = input instanceof Request ? input.url : String(input);
				const headers = new Headers(
					input instanceof Request ? input.headers : init?.headers,
				);
				calls.push({ url, auth: headers.get("authorization") });
				const body = url.endsWith("/access_tokens")
					? {
							token: "ghs_installation",
							expires_at: new Date(Date.now() + 3600_000).toISOString(),
							permissions: {},
							repository_selection: "all",
						}
					: {};
				return new Response(JSON.stringify(body), {
					status: url.endsWith("/access_tokens") ? 201 : 200,
					headers: { "content-type": "application/json" },
				});
			},
		);

		const transport = await installationTransport(
			{ appId: 1, privateKey, installationId: 42 },
			fetchMock as unknown as typeof fetch,
		);
		await transport.request("GET /repos/{owner}/{repo}", repo);
		await transport.request("GET /repos/{owner}/{repo}", repo);

		const mints = calls.filter((c) =>
			c.url.endsWith("/app/installations/42/access_tokens"),
		);
		expect(mints).toHaveLength(1);
		const apiCalls = calls.filter((c) =>
			c.url.endsWith("/repos/agent-of-empires/castellan"),
		);
		expect(apiCalls).toHaveLength(2);
		for (const c of apiCalls) expect(c.auth).toBe("token ghs_installation");
	});
});
