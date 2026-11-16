import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import type { GithubTransport } from "../src/github.js";
import {
	escalationReviewers,
	ownedTeam,
	requestReviewers,
} from "../src/reviewers.js";
import type { CodeownersRule } from "../src/rules.js";

const codeowners = (): CodeownersRule[] => [
	{ pattern: "*", owners: ["@alice"] },
	{ pattern: "src/", owners: ["@o/platform"] },
	{ pattern: "src/generated/", owners: ["@o/codegen", "@bob"] },
];

describe("ownedTeam", () => {
	it("takes the last matching rule's team", () => {
		expect(ownedTeam(["src/a.ts"], codeowners())).toBe("platform");
	});

	it("prefers the deepest rule", () => {
		expect(ownedTeam(["src/generated/x.ts"], codeowners())).toBe("codegen");
	});

	it("skips a rule whose owners are users, not a team", () => {
		expect(ownedTeam(["README.md"], codeowners())).toBeUndefined();
	});

	it("returns the first file that has an owner", () => {
		expect(
			ownedTeam(["README.md", "docs/a.md", "src/a.ts"], codeowners()),
		).toBe("platform");
	});

	it("returns nothing without CODEOWNERS", () => {
		expect(ownedTeam(["src/a.ts"], [])).toBeUndefined();
	});
});

describe("requestReviewers", () => {
	const transport = (error?: Error) => {
		const request = vi.fn(async () => {
			if (error) throw error;
			return { data: {} };
		});
		return {
			request,
			transport: { request } as unknown as GithubTransport,
		};
	};

	it("requests the team and the users", async () => {
		const { request, transport: t } = transport();
		await requestReviewers(t, { owner: "o", repo: "r" }, 3, {
			team: "platform",
			users: ["bob"],
			author: "alice",
		});
		// Two calls, so an invalid user login cannot drop the team request too.
		expect(request).toHaveBeenCalledWith(
			"POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
			{ owner: "o", repo: "r", pull_number: 3, team_reviewers: ["platform"] },
		);
		expect(request).toHaveBeenCalledWith(
			"POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
			{ owner: "o", repo: "r", pull_number: 3, reviewers: ["bob"] },
		);
	});

	it("keeps the team request when the user request fails", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ data: {} })
			.mockRejectedValueOnce(Object.assign(new Error("422"), { status: 422 }));
		await requestReviewers(
			{ request } as unknown as GithubTransport,
			{ owner: "o", repo: "r" },
			3,
			{ team: "platform", users: ["nobody"], author: "alice" },
		);
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("drops the PR's author, which GitHub would reject", async () => {
		const { request, transport: t } = transport();
		await requestReviewers(t, { owner: "o", repo: "r" }, 3, {
			users: ["Alice", "bob"],
			author: "alice",
		});
		expect(request).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ reviewers: ["bob"] }),
		);
	});

	it("sends nothing when there is nobody to ask", async () => {
		const { request, transport: t } = transport();
		await requestReviewers(t, { owner: "o", repo: "r" }, 3, {
			users: [],
			author: "alice",
		});
		expect(request).not.toHaveBeenCalled();
	});

	it("swallows a failure so the escalation still lands", async () => {
		const { transport: t } = transport(new Error("422"));
		await expect(
			requestReviewers(t, { owner: "o", repo: "r" }, 3, {
				team: "platform",
				users: [],
				author: "alice",
			}),
		).resolves.toBeUndefined();
	});
});

describe("escalationReviewers", () => {
	const config = async (yaml: string) => {
		const r = await loadConfig("base", async () => yaml);
		if (!r.ok) throw new Error(r.error);
		return r.config;
	};

	it("prefers the owning team over the configured one", async () => {
		const c = await config("reviewers:\n  team: maintainers\n  users: [bob]");
		expect(escalationReviewers({ ownerTeam: "platform" }, c)).toEqual({
			team: "platform",
			users: ["bob"],
		});
	});

	it("falls back to reviewers.team", async () => {
		const c = await config("reviewers:\n  team: maintainers");
		expect(escalationReviewers({}, c)).toEqual({
			team: "maintainers",
			users: [],
		});
	});

	it("asks nobody by default", async () => {
		expect(escalationReviewers({}, await config(""))).toEqual({
			team: undefined,
			users: [],
		});
	});
});
