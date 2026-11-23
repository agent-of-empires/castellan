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
import { rightLines } from "./diff.js";
import { readFiles, renderFileContext } from "./files.js";
import {
	createGithubClient,
	type GithubTransport,
	type Repo,
} from "./github.js";
import { type LlmDeps, promptHash, review } from "./llm.js";
import { planInline } from "./review.js";
import { ownedTeam } from "./reviewers.js";
import {
	type CodeownersRule,
	type Context,
	evaluate,
	GENERATED,
} from "./rules.js";
import { type AuthorClass, buildSnapshot } from "./snapshot.js";
import {
	findStickyComment,
	postStatus,
	statusFor,
	waitingStatus,
} from "./status.js";
import {
	MAX_THREAD_RERUNS,
	type ReviewThread,
	readThreads,
	renderThreads,
	threadsKey,
} from "./threads.js";
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
		// Read even without teams.protected: the owning team is what an escalation
		// asks for a review, and what the brief names. Without the setting nothing
		// depends on it but a best effort request, so a read error means no team
		// rather than a failed run.
		let codeowners: CodeownersRule[] = [];
		for (const path of CODEOWNERS_PATHS) {
			let text: string | null;
			try {
				text = await read(pr.base.ref, path);
			} catch (err) {
				if (config.teams.protected) throw err;
				text = null;
			}
			if (text !== null) {
				codeowners = parseCodeowners(text);
				break;
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

		// Shadow also runs the model on rule escalations, as advice only.
		let skipModel =
			decision.outcome === "escalate" && (config.mode !== "shadow" || !!error);
		const sticky = await findStickyComment(transport, repoRef, pullNumber, {
			login,
		});
		const cached = sticky ? parseBlock(sticky.body) : null;
		const head = {
			headSha: snapshot.headSha,
			promptHash: promptHash(config),
			model: config.models.review,
		};
		const sameHead =
			!!cached?.llm &&
			cached.headSha === head.headSha &&
			cached.promptHash === head.promptHash &&
			cached.model === head.model;

		// Unresolved threads are what a reviewer answers first, so they are part of
		// the model input and of the cache key: a new thread must re-run the model.
		let threads: ReviewThread[] = [];
		// Threads past `MAX_THREADS` never reach `renderThreads`, so the brief has
		// to count them here or the oldest ones go unmentioned.
		let readDropped = 0;
		let keepCached = false;
		if (!skipModel) {
			const read = await readThreads(transport, repoRef, pullNumber, login);
			if (read.ok) {
				threads = read.threads;
				readDropped = read.dropped;
			} else if (sameHead) {
				// A failed read is not "no threads": keep the verdict this head already has.
				keepCached = true;
			} else {
				decision = {
					outcome: "escalate",
					reasons: [
						{
							rule: "threads_unavailable",
							text: "review threads unavailable, retrying on the next event",
						},
					],
				};
				skipModel = true;
			}
		}
		const rendered = renderThreads(threads);
		const threadKey = threadsKey(threads);
		const spent =
			cached?.headSha === head.headSha ? (cached.threadReruns ?? 0) : 0;
		const threadChanged = sameHead && cached?.threads !== threadKey;
		// Anyone who can comment can change this key, so a head gets a bounded number
		// of thread-driven runs; past the cap the stored verdict stands.
		const capped = threadChanged && spent >= MAX_THREAD_RERUNS;
		// The verdict in hand answered the threads stored with it, not the ones read
		// now, so the brief must not claim those were checked. A block written before
		// `threads` existed keeps its own key, which is what `keepCached` promises.
		const sawThreads = !skipModel && !keepCached && !capped;
		const key = {
			...head,
			threads: keepCached || capped ? cached?.threads : threadKey,
			threadReruns:
				!skipModel && !keepCached && !capped && threadChanged
					? spent + 1
					: spent,
			// Read back from the block, like `threadReruns`: a sweep on this head must
			// still know the reviewers were already asked, even after a human removed
			// the request.
			requested:
				cached?.headSha === head.headSha ? cached.requested : undefined,
			requestedParts:
				cached?.headSha === head.headSha ? cached.requestedParts : undefined,
		};
		const dedup = await getOrRun({
			cached,
			key,
			skipModel,
			run: async () => {
				const linked = snapshot.linkedIssues[0];
				const issue = linked ? await getIssue(env, repoRef, linked) : null;
				// Read at the head: the post-image is what the change would merge as, and
				// the cache key already holds the head sha, so this never goes stale.
				const files = await readFiles(
					transport,
					repoRef,
					snapshot.headSha,
					// Removed, generated and unchanged-size (binary or pure rename) paths
					// are skipped without a request, and the files with the most changed
					// lines come first so the attempt cap is spent where it matters.
					snapshot.files
						.filter((f) => f.status !== "removed")
						.filter((f) => f.additions + f.deletions > 0)
						.filter((f) => !GENERATED.test(f.path))
						.sort(
							(a, b) => b.additions + b.deletions - (a.additions + a.deletions),
						)
						.map((f) => f.path),
				);
				const result = await review(
					{
						title: snapshot.title,
						body: snapshot.body,
						diff: snapshot.diff,
						linkedIssueBody: issue?.body ?? undefined,
						threads: rendered.text,
						files: renderFileContext(files),
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
		// Only a model finding can be anchored: a rule reason has no line in the diff.
		const inline = result?.ok
			? planInline(result.verdict.reasons, rightLines(snapshot.diff))
			: [];
		const brief: Brief = {
			outcome,
			key,
			checks: snapshot.checks,
			threads: sawThreads ? rendered.included || undefined : undefined,
			threadsDropped: sawThreads
				? rendered.dropped + readDropped || undefined
				: undefined,
			threadsCapped: capped || undefined,
			inline: inline.length ? inline : undefined,
			review: result?.ok ? result : undefined,
			reviewError: result && !result.ok ? result.error : undefined,
			source: dedup.source,
			shadow: config.mode === "shadow",
			// The team an escalation asks, so the verdict line names the team asked
			// rather than only a CODEOWNERS one.
			ownerTeam:
				ownedTeam(
					snapshot.files.map((f) => f.path),
					codeowners,
					repoRef.owner,
				) ?? config.reviewers.team,
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
