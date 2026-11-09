import { createHmac, timingSafeEqual } from "node:crypto";
import type { GithubTransport } from "./github.js";
import { type Env, evaluatePull, listWork, triageIssue } from "./pipeline.js";
import type { Secrets } from "./secrets.js";
import { STATUS_CONTEXT } from "./status.js";

export interface Deps {
	/** `owner/repo` list the bot may act on. Empty is a kill switch. */
	repos: string[];
	loadSecrets(): Promise<Secrets>;
	connect(
		secrets: Secrets,
	): Promise<{ transport: GithubTransport; login: string }>;
	llm?: Env["llm"];
}

/** The slice of the Function URL payload (2.0) and the EventBridge sweep event used here. */
export interface LambdaEvent {
	headers?: Record<string, string | undefined>;
	body?: string;
	isBase64Encoded?: boolean;
	source?: string;
}

export interface LambdaContext {
	getRemainingTimeInMillis(): number;
}

export interface LambdaResult {
	statusCode: number;
	body: string;
}

interface Payload {
	action?: string;
	repository?: { full_name: string; owner: { login: string }; name: string };
	pull_request?: { number: number };
	review?: { user?: { login: string } | null };
	check_suite?: { head_sha: string; pull_requests: { number: number }[] };
	issue?: { number: number };
	sha?: string;
	context?: string;
}

type Job = [label: string, run: () => Promise<unknown>];

const PR_ACTIONS = ["opened", "synchronize", "reopened", "ready_for_review"];
/** Stop starting jobs below this much remaining time; one LLM call can take 30s. */
const DEADLINE_MS = 40_000;
const CONCURRENCY = 3;

const reply = (statusCode: number, body: string): LambdaResult => ({
	statusCode,
	body,
});

function validSignature(secret: string, raw: Buffer, header?: string) {
	if (!header) return false;
	const expected = Buffer.from(
		`sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
	);
	const given = Buffer.from(header);
	return given.length === expected.length && timingSafeEqual(given, expected);
}

const outOfTime = (ctx?: LambdaContext) =>
	ctx !== undefined && ctx.getRemainingTimeInMillis() < DEADLINE_MS;

/**
 * Runs jobs with bounded concurrency and stops starting new ones near the
 * deadline. A failing job is logged, not fatal. Returns counts.
 */
async function runAll(jobs: Job[], ctx?: LambdaContext) {
	let next = 0;
	let failed = 0;
	const worker = async () => {
		while (next < jobs.length && !outOfTime(ctx)) {
			const [label, run] = jobs[next++] as Job;
			try {
				console.log(label, await run());
			} catch (err) {
				failed++;
				console.error(label, err);
			}
		}
	};
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));
	return { failed, skipped: jobs.length - next };
}

export function createHandler(deps: Deps) {
	const allowed = new Set(deps.repos.map((r) => r.toLowerCase()));
	// Once per container; a rejection is not cached, so the next invocation retries.
	let secrets: Promise<Secrets> | undefined;
	let env: Promise<Env> | undefined;
	const getSecrets = () => {
		secrets ??= deps.loadSecrets().catch((err) => {
			secrets = undefined;
			throw err;
		});
		return secrets;
	};
	const getEnv = () => {
		env ??= getSecrets()
			.then(deps.connect)
			.then((c) => ({ ...c, llm: deps.llm }))
			.catch((err) => {
				env = undefined;
				throw err;
			});
		return env;
	};

	const pullsForSha = async (e: Env, p: Payload, sha: string) => {
		if (!p.repository) return [];
		const pulls = await e.transport.paginate(
			"GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls",
			{
				owner: p.repository.owner.login,
				repo: p.repository.name,
				commit_sha: sha,
				per_page: 100,
			},
		);
		return pulls
			.filter((pr) => pr.state === "open" && pr.head.sha === sha)
			.map((pr) => pr.number);
	};

	async function pullsFor(name: string, p: Payload, e: Env) {
		switch (name) {
			case "pull_request":
				return p.action && PR_ACTIONS.includes(p.action) && p.pull_request
					? [p.pull_request.number]
					: [];
			case "pull_request_review":
				// Skip our own approval, or every approval would re-run the pipeline.
				return p.action === "submitted" &&
					p.pull_request &&
					p.review?.user?.login !== e.login
					? [p.pull_request.number]
					: [];
			case "check_suite": {
				// check_run is not routed: it fires once per check, check_suite once per head.
				if (p.action !== "completed" || !p.check_suite) return [];
				const { pull_requests, head_sha } = p.check_suite;
				// Fork PRs come with an empty list; find them by head sha.
				return pull_requests.length
					? pull_requests.map((n) => n.number)
					: pullsForSha(e, p, head_sha);
			}
			case "status":
				// Our own status would re-trigger us.
				return p.sha && p.context !== STATUS_CONTEXT
					? pullsForSha(e, p, p.sha)
					: [];
			default:
				return [];
		}
	}

	async function webhook(
		event: LambdaEvent,
		ctx?: LambdaContext,
	): Promise<LambdaResult> {
		const raw = event.isBase64Encoded
			? Buffer.from(event.body ?? "", "base64")
			: Buffer.from(event.body ?? "");
		const { webhook_secret } = await getSecrets();
		if (
			!validSignature(
				webhook_secret,
				raw,
				event.headers?.["x-hub-signature-256"],
			)
		) {
			return reply(401, "invalid signature");
		}
		const name = event.headers?.["x-github-event"] ?? "";
		let p: Payload;
		try {
			p = JSON.parse(raw.toString("utf8"));
		} catch {
			return reply(400, "invalid json");
		}
		const full = p.repository?.full_name;
		if (!p.repository || !full || !allowed.has(full.toLowerCase())) {
			return reply(200, "ignored: repository not allowed");
		}
		const e = await getEnv();
		const repoRef = {
			owner: p.repository.owner.login,
			repo: p.repository.name,
		};
		const issue = p.issue?.number;
		const jobs: Job[] =
			name === "issues" && p.action === "opened" && issue
				? [[`issue ${full}#${issue}`, () => triageIssue(e, repoRef, issue)]]
				: (await pullsFor(name, p, e)).map((n) => [
						`pull ${full}#${n}`,
						() => evaluatePull(e, repoRef, n),
					]);
		if (!jobs.length) {
			return reply(200, `ignored: ${name} ${p.action ?? ""}`.trim());
		}
		// Per-job failures are logged; only infrastructure errors return 500.
		const { failed, skipped } = await runAll(jobs, ctx);
		return reply(200, `ok failed=${failed} skipped=${skipped}`);
	}

	async function sweep(ctx?: LambdaContext) {
		const e = await getEnv();
		let infra = 0;
		for (const full of deps.repos) {
			if (outOfTime(ctx)) {
				console.error(`sweep stopped before ${full}: out of time`);
				break;
			}
			const [owner = "", repo = ""] = full.split("/");
			const repoRef = { owner, repo };
			try {
				const { pulls, issues } = await listWork(e, repoRef);
				const jobs: Job[] = [
					...pulls.map(
						(n): Job => [
							`pull ${full}#${n}`,
							() => evaluatePull(e, repoRef, n),
						],
					),
					...issues.map(
						(n): Job => [
							`issue ${full}#${n}`,
							() => triageIssue(e, repoRef, n),
						],
					),
				];
				const { skipped } = await runAll(jobs, ctx);
				if (skipped)
					console.error(`sweep ${full}: ${skipped} jobs not started`);
			} catch (err) {
				infra++;
				console.error(`sweep ${full}`, err);
			}
		}
		return reply(infra ? 500 : 200, infra ? "failed" : "ok");
	}

	return async (
		event: LambdaEvent,
		ctx?: LambdaContext,
	): Promise<LambdaResult> => {
		if (!allowed.size) return reply(200, "disabled");
		try {
			if (event.headers) return await webhook(event, ctx);
			if (event.source === "sweep") return await sweep(ctx);
			return reply(400, "unsupported event");
		} catch (err) {
			console.error("infrastructure failure", err);
			return reply(500, "internal error");
		}
	};
}
