import { vi } from "vitest";
import type { GithubTransport } from "../src/github.js";
import type { MessagesClient } from "../src/llm.js";

export const COMMENT =
	"POST /repos/{owner}/{repo}/issues/{issue_number}/comments";
export const APPROVE = "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews";

export interface World {
	config?: string | null;
	draft?: boolean;
	files?: { filename: string; additions: number; deletions: number }[];
	login?: string;
}

export function fake(w: World = {}) {
	let sticky: string | null = null;
	const files = w.files ?? [
		{ filename: "src/a.ts", additions: 2, deletions: 1 },
	];
	const request = vi.fn(
		async (
			route: string,
			p: { path?: string; mediaType?: object; body?: string } = {},
		) => {
			if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
				if (p.path === ".castellan.yml" && w.config != null) {
					return { data: w.config };
				}
				throw Object.assign(new Error("nf"), { status: 404 });
			}
			if (route === "GET /repos/{owner}/{repo}") {
				return { data: { default_branch: "main" } };
			}
			if (route === "GET /repos/{owner}/{repo}/pulls/{pull_number}") {
				if (p.mediaType) return { data: "+a" };
				return {
					data: {
						state: "open",
						merged: false,
						draft: w.draft ?? false,
						title: "fix: a",
						body: "Closes #5",
						node_id: "PR_1",
						auto_merge: null,
						user: { login: w.login ?? "alice", type: "User" },
						base: { ref: "main", sha: "base1" },
						head: { ref: "fix-a", sha: "head1" },
					},
				};
			}
			if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}") {
				return {
					data: {
						state: "open",
						title: "t",
						body: "the issue",
						labels: [{ name: "bug" }],
					},
				};
			}
			if (route === COMMENT) {
				sticky = p.body ?? null;
				return { data: { id: 7, html_url: "https://x/c" } };
			}
			return { data: { id: 7, html_url: "https://x/c" } };
		},
	);
	const paginate = vi.fn(async (route: string) => {
		if (route.endsWith("/files")) return files;
		if (route.endsWith("/comments") && sticky) {
			return [{ id: 7, user: { login: "castellan[bot]" }, body: sticky }];
		}
		if (route === "GET /repos/{owner}/{repo}/pulls") {
			return [
				{ number: 1, draft: false },
				{ number: 2, draft: true },
			];
		}
		if (route === "GET /repos/{owner}/{repo}/issues") {
			return [{ number: 9 }, { number: 10, pull_request: {} }];
		}
		return [];
	});
	const graphql = vi.fn(async () => ({}));
	const transport = {
		request,
		paginate,
		graphql,
	} as unknown as GithubTransport;
	const routes = () => request.mock.calls.map((c) => c[0]);
	return { transport, request, graphql, routes };
}

export const llm = (verdict: object) => {
	const create = vi.fn(async () => ({
		content: [{ type: "text", text: JSON.stringify(verdict) }],
		usage: { input_tokens: 10, output_tokens: 5 },
	}));
	return {
		create,
		deps: { client: { messages: { create } } as unknown as MessagesClient },
	};
};
export const merge = { intent_match: true, new_behavior: false, reasons: [] };
