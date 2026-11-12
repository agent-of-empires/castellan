import { type ActResult, act } from "./act.js";
import { getOrRun, parseBlock } from "./cache.js";
import {
	type CentralResult,
	type ConfigSource,
	loadCentral,
	parseLocator,
} from "./central.js";
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
import {
	findStickyComment,
	postStatus,
	statusFor,
	waitingStatus,
} from "./status.js";
import { type TriageResult, triage } from "./triage.js";
import { decide } from "./verdict.js";

export interface Env {
	transport: GithubTransport;
	/** The App's `<slug>[bot]` login. */
	login: string;
	llm?: LlmDeps;
	/** Overrides `mode` from `.castellan.yml`. */
	mode?: Config["mode"];
	/** Where policy comes from; `repo` when unset. */
	configSource?: ConfigSource;
	/** `CASTELLAN_CENTRAL_CONFIG`; unset means `<owner>/.github`. */
	centralLocator?: string;
	/** Memo for the central file, one per invocation so a merged change applies on the next event. */
	centralCache?: Map<string, Promise<CentralResult>>;
	/** For the S3 locator. */
	fetch?: typeof fetch;
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
	const source = env.configSource ?? "repo";
	if (source === "db")
		throw new Error("config source db is not implemented yet");
	const central =
		source === "central"
			? await loadCentral(
					{
						transport: env.transport,
						fetch: env.fetch,
						cache: env.centralCache,
					},
					parseLocator(env.centralLocator, repoRef.owner),
				)
			: undefined;
	const loaded =
		central && !central.ok
			? central
			: await loadConfig(ref ?? data.default_branch, read, central?.doc);
	const withMode = (config: Config) =>
		env.mode ? { ...config, mode: env.mode } : config;
	if (loaded.ok) {
		return {
			config: withMode(loaded.config),
			defaultBranch: data.default_branch,
		};
	}
	const fallback = await loadConfig("", async () => null);
	if (!fallback.ok) throw new Error(fallback.error);
	return {
		config: withMode(fallback.config),
		defaultBranch: data.default_branch,
		error: loaded.error,
	};
}

/** The central file's path when this repo is the central git repo, so edits to it escalate. */
function centralPathIn(env: Env, { owner, repo }: Repo) {
	if (env.configSource !== "central") return undefined;
	const loc = parseLocator(env.centralLocator, owner);
	return loc.kind === "git" &&
		loc.owner.toLowerCase() === owner.toLowerCase() &&
		loc.repo.toLowerCase() === repo.toLowerCase()
		? loc.path
		: undefined;
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

export interface PullResult {
	status: "closed" | "skipped" | "waiting" | "acted" | "dry_run";
	brief?: Brief;
	act?: ActResult;
}

/**
 * Runs the full pipeline for one PR: snapshot, rules, model, verdict, act.
 * With `dryRun` nothing is written (no comment, status, approval or merge) and
 * the brief is returned. Once the head is known (team lookup and snapshot included), a failure sets the status to
 * pending (success in shadow) so a stale `success` cannot stay, then rethrows.
 */
export async function evaluatePull(
	env: Env,
	repoRef: Repo,
	pullNumber: number,
	opts: { dryRun?: boolean } = {},
): Promise<PullResult> {
	const { transport, login } = env;
	const { owner, repo } = repoRef;
	const { data: pr } = await transport.request(
		"GET /repos/{owner}/{repo}/pulls/{pull_number}",
		{ owner, repo, pull_number: pullNumber },
	);
	if (pr.state !== "open") return { status: "closed" };

	const { config, defaultBranch, error } = await repoConfig(
		env,
		repoRef,
		pr.base.ref,
	);
	if (!error && config.mode === "off") return { status: "skipped" };

	const run = async (): Promise<PullResult> => {
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
				const text = await read(pr.base.ref, path);
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
		const ctx: Context = {
			now: Date.now(),
			defaultBranch,
			codeowners,
			bugIssues,
			centralPath: centralPathIn(env, repoRef),
		};

		const required = await createGithubClient(
			transport,
			repoRef,
		).requiredChecks(snapshot.baseRef);
		let decision = evaluate(snapshot, config, required, ctx);
		if (decision.outcome === "skip") return { status: "skipped" };
		if (error) {
			decision = {
				outcome: "escalate",
				reasons: [{ rule: "config_invalid", text: error }],
			};
		}

		if (decision.outcome === "wait") {
			if (!opts.dryRun) {
				await postStatus(
					transport,
					repoRef,
					snapshot.headSha,
					waitingStatus(config.mode),
				);
			}
			return { status: "waiting" };
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
			// Shadow also runs the model on rule escalations, as advice only.
			skipModel:
				decision.outcome === "escalate" &&
				(config.mode !== "shadow" || !!error),
			run: async () => {
				const linked = snapshot.linkedIssues[0];
				const issue = linked ? await getIssue(env, repoRef, linked) : null;
				const result = await review(
					{
						title: snapshot.title,
						body: snapshot.body,
						diff: snapshot.diff,
						linkedIssueBody: issue?.body ?? undefined,
					},
					config,
					env.llm,
				);
				if (!result.ok)
					console.warn("model review failed", {
						error: result.error,
						detail: result.detail?.slice(0, 500),
					});
				return result;
			},
		});
		const result = dedup.source === "skipped" ? undefined : dedup.result;
		const outcome = decide(decision, result);
		if (!outcome) return { status: "skipped" };
		const brief: Brief = {
			outcome,
			key,
			checks: snapshot.checks,
			review: result?.ok ? result : undefined,
			reviewError: result && !result.ok ? result.error : undefined,
			source: dedup.source,
			shadow: config.mode === "shadow",
		};
		if (opts.dryRun) return { status: "dry_run", brief };
		const acted = await act(transport, repoRef, {
			pullNumber,
			snapshot,
			config,
			ctx,
			brief,
			author: { login },
		});
		return { status: "acted", brief, act: acted };
	};
	if (opts.dryRun) return run();
	try {
		return await run();
	} catch (err) {
		await postStatus(transport, repoRef, pr.head.sha, {
			...statusFor("escalate", config.mode),
			description: `${config.mode === "shadow" ? "shadow" : "castellan"}: internal error`,
		}).catch((e) => console.error("fail-closed status failed", e));
		throw err;
	}
}

/** Triages one open issue against the config on the default branch. */
export async function triageIssue(
	env: Env,
	repoRef: Repo,
	issueNumber: number,
	opts: { dryRun?: boolean; label?: string } = {},
): Promise<TriageResult | "closed"> {
	const issue = await getIssue(env, repoRef, issueNumber);
	if (issue?.state !== "open" || issue.pull_request) return "closed";
	const { config, error } = await repoConfig(env, repoRef);
	if (error) throw new Error(error);
	// A `labeled` event for any other label is not a triage trigger.
	if (opts.label !== undefined && opts.label !== config.labels.needsTriage) {
		return { ok: true, skipped: "other label" };
	}
	return triage(
		{ number: issueNumber, title: issue.title, body: issue.body ?? "" },
		config,
		env.transport,
		repoRef,
		env.llm,
		{ dryRun: opts.dryRun, login: env.login },
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
