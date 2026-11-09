import { act } from "./act.js";
import { getOrRun, parseBlock } from "./cache.js";
import type { Brief } from "./comment.js";
import { type Config, githubReader, loadConfig } from "./config.js";
import {
	createGithubClient,
	type GithubTransport,
	type Repo,
} from "./github.js";
import { type LlmDeps, promptHash, review } from "./llm.js";
import { type CodeownersRule, type Context, evaluate } from "./rules.js";
import { type AuthorClass, buildSnapshot } from "./snapshot.js";
import { findStickyComment } from "./status.js";
import { type TriageResult, triage } from "./triage.js";
import { decide } from "./verdict.js";

export interface Env {
	transport: GithubTransport;
	/** The App's `<slug>[bot]` login. */
	login: string;
	llm?: LlmDeps;
}

const CODEOWNERS_PATHS = [
	".github/CODEOWNERS",
	"CODEOWNERS",
	"docs/CODEOWNERS",
];

function parseCodeowners(text: string): CodeownersRule[] {
	return text.split("\n").flatMap((line) => {
		const [pattern, ...owners] = line.replace(/#.*/, "").trim().split(/\s+/);
		return pattern ? [{ pattern, owners }] : [];
	});
}

/** Config at `ref` and the repo default branch. A bad config falls back to defaults (shadow) with the error kept. */
async function repoConfig(env: Env, repoRef: Repo, ref?: string) {
	const { data } = await env.transport.request("GET /repos/{owner}/{repo}", {
		...repoRef,
	});
	const read = githubReader(env.transport, repoRef);
	const loaded = await loadConfig(ref ?? data.default_branch, read);
	if (loaded.ok) {
		return { config: loaded.config, defaultBranch: data.default_branch };
	}
	const fallback = await loadConfig("", async () => null);
	if (!fallback.ok) throw new Error(fallback.error);
	return {
		config: fallback.config,
		defaultBranch: data.default_branch,
		error: loaded.error,
	};
}

async function classify(
	env: Env,
	{ owner, repo }: Repo,
	config: Config,
	login: string,
): Promise<AuthorClass> {
	if (login.endsWith("[bot]")) return "bot";
	const team = config.teams.maintainers;
	const client = createGithubClient(env.transport, { owner, repo });
	if (team && (await client.isTeamMember(owner, team, login))) {
		return "maintainer";
	}
	return config.trustedAuthors.includes(login) ? "trusted" : "external";
}

/** Null when the issue cannot be read; callers treat that as "not a match", which fails closed. */
const getIssue = (env: Env, { owner, repo }: Repo, issue_number: number) =>
	env.transport
		.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
			owner,
			repo,
			issue_number,
		})
		.then((r) => r.data)
		.catch(() => null);

/** Runs the full pipeline for one PR: snapshot, rules, model, verdict, act. */
export async function evaluatePull(
	env: Env,
	repoRef: Repo,
	pullNumber: number,
): Promise<"closed" | "skipped" | "acted"> {
	const { transport, login } = env;
	const { owner, repo } = repoRef;
	const { data: pr } = await transport.request(
		"GET /repos/{owner}/{repo}/pulls/{pull_number}",
		{ owner, repo, pull_number: pullNumber },
	);
	if (pr.state !== "open") return "closed";

	const { config, defaultBranch, error } = await repoConfig(
		env,
		repoRef,
		pr.base.sha,
	);
	const authorClass = await classify(env, repoRef, config, pr.user.login);
	const snapshot = await buildSnapshot(
		transport,
		repoRef,
		pullNumber,
		authorClass,
	);

	const read = githubReader(transport, repoRef);
	let codeowners: CodeownersRule[] = [];
	if (config.teams.protected) {
		for (const path of CODEOWNERS_PATHS) {
			const text = await read(snapshot.baseSha, path);
			if (text !== null) {
				codeowners = parseCodeowners(text);
				break;
			}
		}
	}
	const bugIssues: number[] = [];
	if (authorClass === "external") {
		for (const n of snapshot.linkedIssues) {
			const issue = await getIssue(env, repoRef, n);
			const labels = issue?.labels.map((l) =>
				typeof l === "string" ? l : l.name,
			);
			if (labels?.includes(config.labels.bug)) bugIssues.push(n);
		}
	}
	const ctx: Context = { defaultBranch, codeowners, bugIssues };

	const required = await createGithubClient(transport, repoRef).requiredChecks(
		snapshot.baseRef,
	);
	let decision = evaluate(snapshot, config, required, ctx);
	if (decision.outcome === "skip") return "skipped";
	if (error) {
		decision = {
			outcome: "escalate",
			reasons: [{ rule: "config_invalid", text: error }],
		};
	}

	const sticky = await findStickyComment(transport, repoRef, pullNumber, {
		login,
	});
	const key = {
		headSha: snapshot.headSha,
		promptHash: promptHash(config),
		model: config.models.review,
	};
	const dedup = await getOrRun({
		cached: sticky ? parseBlock(sticky.body) : null,
		key,
		ruleEscalated: decision.outcome === "escalate",
		run: async () => {
			const linked = snapshot.linkedIssues[0];
			const issue = linked ? await getIssue(env, repoRef, linked) : null;
			return review(
				{
					title: snapshot.title,
					body: snapshot.body,
					diff: snapshot.diff,
					linkedIssueBody: issue?.body ?? undefined,
				},
				config,
				env.llm,
			);
		},
	});
	const result = dedup.source === "skipped" ? undefined : dedup.result;
	const outcome = decide(decision, result);
	if (!outcome) return "skipped";
	const brief: Brief = {
		outcome,
		key,
		checks: snapshot.checks,
		review: result?.ok ? result : undefined,
		source: dedup.source,
	};
	await act(transport, repoRef, {
		pullNumber,
		snapshot,
		config,
		ctx,
		brief,
		author: { login },
	});
	return "acted";
}

/** Triages one open issue against the config on the default branch. */
export async function triageIssue(
	env: Env,
	repoRef: Repo,
	issueNumber: number,
): Promise<TriageResult | "closed"> {
	const issue = await getIssue(env, repoRef, issueNumber);
	if (issue?.state !== "open" || issue.pull_request) return "closed";
	const { config, error } = await repoConfig(env, repoRef);
	if (error) throw new Error(error);
	return triage(
		{ number: issueNumber, title: issue.title, body: issue.body ?? "" },
		config,
		env.transport,
		repoRef,
		env.llm,
	);
}

/** Open PRs and needs-triage issues of one repo, for the EventBridge sweep. */
export async function listWork(env: Env, repoRef: Repo) {
	const { owner, repo } = repoRef;
	const { config } = await repoConfig(env, repoRef);
	const pulls = await env.transport.paginate(
		"GET /repos/{owner}/{repo}/pulls",
		{ owner, repo, state: "open", per_page: 100 },
	);
	const issues = await env.transport.paginate(
		"GET /repos/{owner}/{repo}/issues",
		{
			owner,
			repo,
			state: "open",
			labels: config.labels.needsTriage,
			per_page: 100,
		},
	);
	return {
		pulls: pulls.map((p) => p.number),
		issues: issues.filter((i) => !i.pull_request).map((i) => i.number),
	};
}
