/**
 * The single pipeline entry shared by every adapter (Action, CLI, and the Lambda
 * adapter): one PR or one issue in, one result out. Adapters only resolve
 * credentials and the event; nothing here knows how it was invoked.
 */
import { type ActResult, act } from "./act.js";
import { getOrRun, parseBlock } from "./cache.js";
import type { Brief } from "./comment.js";
import { type Config, githubReader, loadConfig } from "./config.js";
import {
	createGithubClient,
	type GithubTransport,
	type Repo,
} from "./github.js";
import { type LlmDeps, promptHash, review } from "./llm.js";
import {
	type CodeownersRule,
	evaluate,
	type Reason,
	type Context as RulesContext,
} from "./rules.js";
import { type AuthorClass, buildSnapshot } from "./snapshot.js";
import { type Author, findStickyComment } from "./status.js";
import { type TriageResult, triage } from "./triage.js";
import { decide } from "./verdict.js";

export interface RunDeps {
	transport: GithubTransport;
	repo: Repo;
	/** The App's `<slug>[bot]` login, used to find its own comment and approval. */
	author: Author & { login: string };
	llm?: LlmDeps;
	/** Overrides `mode` from `.castellan.yml`. */
	mode?: Config["mode"];
}

export type RunResult =
	| { status: "config_error" | "error"; error: string }
	| { status: "skipped"; reasons: Reason[] }
	| { status: "done"; brief: Brief; act: ActResult }
	| { status: "triaged"; triage: TriageResult };

export interface Item {
	kind: "pr" | "issue";
	number: number;
	result: RunResult;
}

export const failed = ({ result: r }: Item) =>
	r.status === "config_error" ||
	r.status === "error" ||
	(r.status === "triaged" && !r.triage.ok);

const CODEOWNERS_PATHS = [
	".github/CODEOWNERS",
	"CODEOWNERS",
	"docs/CODEOWNERS",
];
/** Linked issues looked up per PR; the rest count as unlabeled, which fails closed. */
const MAX_LINKED = 10;

const notFound = (e: unknown) => (e as { status?: number }).status === 404;

async function loadAt(deps: RunDeps, ref: string) {
	const loaded = await loadConfig(ref, githubReader(deps.transport, deps.repo));
	if (!loaded.ok) return loaded;
	const config = deps.mode
		? { ...loaded.config, mode: deps.mode }
		: loaded.config;
	return { ok: true as const, config };
}

async function classify(
	deps: RunDeps,
	config: Config,
	login: string,
	type: string,
): Promise<AuthorClass> {
	if (login.endsWith("[bot]") || type === "Bot") return "bot";
	const team = config.teams.maintainers;
	if (
		team &&
		(await createGithubClient(deps.transport, deps.repo).isTeamMember(
			deps.repo.owner,
			team,
			login,
		))
	) {
		return "maintainer";
	}
	return config.trustedAuthors.includes(login) ? "trusted" : "external";
}

async function loadCodeowners(
	deps: RunDeps,
	baseSha: string,
): Promise<CodeownersRule[]> {
	const readFile = githubReader(deps.transport, deps.repo);
	for (const path of CODEOWNERS_PATHS) {
		const text = await readFile(baseSha, path);
		if (text === null) continue;
		return text.split("\n").flatMap((line) => {
			const [pattern, ...owners] = line.replace(/#.*/, "").trim().split(/\s+/);
			return pattern ? [{ pattern, owners }] : [];
		});
	}
	return [];
}

async function linkedIssues(deps: RunDeps, numbers: number[]) {
	const { transport, repo } = deps;
	const found = await Promise.all(
		numbers.slice(0, MAX_LINKED).map(async (issue_number) => {
			try {
				const { data } = await transport.request(
					"GET /repos/{owner}/{repo}/issues/{issue_number}",
					{ ...repo, issue_number },
				);
				return [{ number: issue_number, body: data.body, labels: data.labels }];
			} catch (e) {
				if (notFound(e)) return [];
				throw e;
			}
		}),
	);
	return found.flat();
}

/** Evaluates one PR: rules, then the model if the rules leave a candidate, then acts by mode. */
export async function runForPr(
	deps: RunDeps,
	pullNumber: number,
): Promise<RunResult> {
	const { transport, repo, author } = deps;
	const { data: pr } = await transport.request(
		"GET /repos/{owner}/{repo}/pulls/{pull_number}",
		{ ...repo, pull_number: pullNumber },
	);
	// Config comes from the base SHA only, never from the PR head.
	const loaded = await loadAt(deps, pr.base.sha);
	if (!loaded.ok) return { status: "config_error", error: loaded.error };
	const { config } = loaded;

	const authorClass = await classify(deps, config, pr.user.login, pr.user.type);
	const snapshot = await buildSnapshot(
		transport,
		repo,
		pullNumber,
		authorClass,
	);
	const [{ data: repoInfo }, codeowners, linked, required] = await Promise.all([
		transport.request("GET /repos/{owner}/{repo}", { ...repo }),
		loadCodeowners(deps, snapshot.baseSha),
		linkedIssues(deps, snapshot.linkedIssues),
		createGithubClient(transport, repo).requiredChecks(snapshot.baseRef),
	]);
	const ctx: RulesContext = {
		defaultBranch: repoInfo.default_branch,
		codeowners,
		bugIssues: linked
			.filter((i) =>
				i.labels.some(
					(l) => (typeof l === "string" ? l : l.name) === config.labels.bug,
				),
			)
			.map((i) => i.number),
	};

	const decision = evaluate(snapshot, config, required, ctx);
	if (decision.outcome === "skip") {
		return { status: "skipped", reasons: decision.reasons };
	}

	const key = {
		headSha: snapshot.headSha,
		promptHash: promptHash(config),
		model: config.models.review,
	};
	const ruleEscalated = decision.outcome === "escalate";
	const sticky = ruleEscalated
		? null
		: await findStickyComment(transport, repo, pullNumber, author);
	const dedup = await getOrRun({
		cached: sticky ? parseBlock(sticky.body) : null,
		key,
		ruleEscalated,
		run: () =>
			review(
				{
					title: snapshot.title,
					body: snapshot.body,
					diff: snapshot.diff,
					linkedIssueBody: linked[0]?.body ?? undefined,
				},
				config,
				deps.llm,
			),
	});
	const result = dedup.source === "skipped" ? undefined : dedup.result;
	// Not null: `skip` returned above.
	const outcome = decide(decision, result) as NonNullable<
		ReturnType<typeof decide>
	>;
	const brief: Brief = {
		outcome,
		key,
		checks: snapshot.checks,
		...(result?.ok && { review: result }),
		source: dedup.source,
	};
	return {
		status: "done",
		brief,
		act: await act(transport, repo, {
			pullNumber,
			snapshot,
			config,
			ctx,
			brief,
			author,
		}),
	};
}

/** Triages one issue. Config comes from the default branch, since an issue has no base SHA. */
export async function runForIssue(
	deps: RunDeps,
	issueNumber: number,
): Promise<RunResult> {
	const { transport, repo } = deps;
	const [{ data: repoInfo }, { data: issue }] = await Promise.all([
		transport.request("GET /repos/{owner}/{repo}", { ...repo }),
		transport.request("GET /repos/{owner}/{repo}/issues/{issue_number}", {
			...repo,
			issue_number: issueNumber,
		}),
	]);
	const loaded = await loadAt(deps, repoInfo.default_branch);
	if (!loaded.ok) return { status: "config_error", error: loaded.error };
	return {
		status: "triaged",
		triage: await triage(
			{ number: issueNumber, title: issue.title, body: issue.body ?? "" },
			loaded.config,
			transport,
			repo,
			deps.llm,
		),
	};
}

/** Every open non-draft PR, then every open issue carrying the needs-triage label. One failure does not stop the rest. */
export async function sweep(deps: RunDeps): Promise<Item[]> {
	const { transport, repo } = deps;
	const { data: repoInfo } = await transport.request(
		"GET /repos/{owner}/{repo}",
		{ ...repo },
	);
	const loaded = await loadAt(deps, repoInfo.default_branch);
	if (!loaded.ok) throw new Error(loaded.error);
	const [pulls, issues] = await Promise.all([
		transport.paginate("GET /repos/{owner}/{repo}/pulls", {
			...repo,
			state: "open",
			per_page: 100,
		}),
		transport.paginate("GET /repos/{owner}/{repo}/issues", {
			...repo,
			state: "open",
			labels: loaded.config.labels.needsTriage,
			per_page: 100,
		}),
	]);
	const todo = [
		...pulls
			.filter((p) => !p.draft)
			.map((p) => ({ kind: "pr" as const, number: p.number })),
		...issues
			.filter((i) => !i.pull_request)
			.map((i) => ({ kind: "issue" as const, number: i.number })),
	];
	const items: Item[] = [];
	for (const { kind, number } of todo) {
		const result = await (kind === "pr" ? runForPr : runForIssue)(
			deps,
			number,
		).catch(
			(e): RunResult => ({
				status: "error",
				error: e instanceof Error ? e.message : String(e),
			}),
		);
		items.push({ kind, number, result });
	}
	return items;
}

/**
 * Reads pass through; every REST write is swallowed and its comment body handed to
 * `print`, and any GraphQL mutation throws. Also forces `shadow`.
 */
export function dryRun(deps: RunDeps, print: (body: string) => void): RunDeps {
	const { transport } = deps;
	const request = async (route: string, params?: { body?: string }) => {
		if (route.startsWith("GET ")) {
			return transport.request(route as never, params as never);
		}
		if (params?.body) print(params.body);
		return { data: { id: 0, html_url: "" } };
	};
	return {
		...deps,
		mode: "shadow",
		transport: {
			request: request as unknown as GithubTransport["request"],
			paginate: transport.paginate,
			graphql: ((query: string, variables?: Record<string, unknown>) => {
				if (/^\s*mutation\b/.test(query)) {
					throw new Error("dry run refuses GraphQL mutations");
				}
				return transport.graphql(query, variables);
			}) as GithubTransport["graphql"],
		},
	};
}
