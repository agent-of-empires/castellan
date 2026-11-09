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

export interface LambdaResult {
	statusCode: number;
	body: string;
}

interface Payload {
	action?: string;
	repository?: { full_name: string; owner: { login: string }; name: string };
	pull_request?: { number: number };
	review?: { user?: { login: string } | null };
	check_suite?: { pull_requests: { number: number }[] };
	check_run?: { pull_requests: { number: number }[] };
	issue?: { number: number };
	sha?: string;
	context?: string;
}

const PR_ACTIONS = ["opened", "synchronize", "reopened", "ready_for_review"];
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

/** Runs every job, logs failures instead of aborting, and returns the failure count. */
async function runAll(jobs: [string, () => Promise<unknown>][]) {
	let failed = 0;
	for (const [label, job] of jobs) {
		try {
			console.log(label, await job());
		} catch (err) {
			failed++;
			console.error(label, err);
		}
	}
	return failed;
}

export function createHandler(deps: Deps) {
	const allowed = new Set(deps.repos.map((r) => r.toLowerCase()));
	// Once per container: secrets, then the GitHub connection.
	let secrets: Promise<Secrets> | undefined;
	let env: Promise<Env> | undefined;
	const getSecrets = () => {
		secrets ??= deps.loadSecrets();
		return secrets;
	};
	const getEnv = () => {
		env ??= getSecrets()
			.then(deps.connect)
			.then((c) => ({ ...c, llm: deps.llm }));
		return env;
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
			case "check_suite":
			case "check_run": {
				const pulls = (p.check_suite ?? p.check_run)?.pull_requests ?? [];
				return p.action === "completed" ? pulls.map((n) => n.number) : [];
			}
			case "status": {
				// Our own status would re-trigger us.
				if (!p.sha || p.context === STATUS_CONTEXT || !p.repository) return [];
				const { owner, name: repo } = p.repository;
				const pulls = await e.transport.paginate(
					"GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls",
					{ owner: owner.login, repo, commit_sha: p.sha, per_page: 100 },
				);
				return pulls
					.filter((pr) => pr.state === "open" && pr.head.sha === p.sha)
					.map((pr) => pr.number);
			}
			default:
				return [];
		}
	}

	async function webhook(event: LambdaEvent): Promise<LambdaResult> {
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
		const p = JSON.parse(raw.toString("utf8")) as Payload;
		const full = p.repository?.full_name;
		if (!full || !allowed.has(full.toLowerCase())) {
			return reply(200, "ignored: repository not allowed");
		}
		const e = await getEnv();
		const repoRef = {
			owner: p.repository?.owner.login ?? "",
			repo: p.repository?.name ?? "",
		};
		const jobs: [string, () => Promise<unknown>][] =
			name === "issues" && p.action === "opened" && p.issue
				? [
						[
							`issue ${full}#${p.issue.number}`,
							() => triageIssue(e, repoRef, p.issue?.number ?? 0),
						],
					]
				: (await pullsFor(name, p, e)).map((n) => [
						`pull ${full}#${n}`,
						() => evaluatePull(e, repoRef, n),
					]);
		if (!jobs.length)
			return reply(200, `ignored: ${name} ${p.action ?? ""}`.trim());
		return (await runAll(jobs)) ? reply(500, "failed") : reply(200, "ok");
	}

	async function sweep() {
		const e = await getEnv();
		let failed = 0;
		for (const full of deps.repos) {
			const [owner = "", repo = ""] = full.split("/");
			const repoRef = { owner, repo };
			try {
				const { pulls, issues } = await listWork(e, repoRef);
				failed += await runAll([
					...pulls.map((n): [string, () => Promise<unknown>] => [
						`pull ${full}#${n}`,
						() => evaluatePull(e, repoRef, n),
					]),
					...issues.map((n): [string, () => Promise<unknown>] => [
						`issue ${full}#${n}`,
						() => triageIssue(e, repoRef, n),
					]),
				]);
			} catch (err) {
				failed++;
				console.error(`sweep ${full}`, err);
			}
		}
		return reply(failed ? 500 : 200, failed ? "failed" : "ok");
	}

	return async (event: LambdaEvent): Promise<LambdaResult> => {
		if (!allowed.size) return reply(200, "disabled");
		if (event.headers) return webhook(event);
		if (event.source === "sweep") return sweep();
		return reply(400, "unsupported event");
	};
}
