/** GitHub Action adapter. Reads the event from GITHUB_EVENT_PATH and credentials from INPUT_* (see action.yml). */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import type { Repo } from "../github.js";
import { type Env, evaluatePull, listWork, triageIssue } from "../pipeline.js";
import { type AuthInput, parseMode, resolveAuth } from "./auth.js";
import { failed, type Item } from "./result.js";

interface Payload {
	pull_request?: {
		number: number;
		head?: { repo?: { fork?: boolean } | null };
	};
	issue?: { number: number };
}

const run = (env: Env, repo: Repo, kind: Item["kind"], number: number) =>
	kind === "pr"
		? evaluatePull(env, repo, number)
		: triageIssue(env, repo, number);

/**
 * `pull_request_target` is refused: it hands write secrets to code from a fork.
 * A fork PR has a read-only token, so it does no work here; the next sweep picks it up.
 * A single event throws on failure; a sweep records each item's error and carries on.
 */
export async function handleEvent(
	name: string,
	payload: Payload,
	env: Env,
	repo: Repo,
): Promise<Item[]> {
	switch (name) {
		case "pull_request": {
			const pr = payload.pull_request;
			if (!pr?.number) throw new Error("event has no pull_request.number");
			if (pr.head?.repo?.fork) return [];
			return [
				{
					kind: "pr",
					number: pr.number,
					result: await run(env, repo, "pr", pr.number),
				},
			];
		}
		case "issues": {
			const number = payload.issue?.number;
			if (!number) throw new Error("event has no issue.number");
			return [
				{
					kind: "issue",
					number,
					result: await run(env, repo, "issue", number),
				},
			];
		}
		case "schedule":
		case "workflow_dispatch": {
			const { pulls, issues } = await listWork(env, repo);
			const items: Item[] = [];
			const todo = [
				...pulls.map((n) => ["pr", n] as const),
				...issues.map((n) => ["issue", n] as const),
			];
			for (const [kind, number] of todo) {
				try {
					items.push({
						kind,
						number,
						result: await run(env, repo, kind, number),
					});
				} catch (e) {
					items.push({
						kind,
						number,
						error: e instanceof Error ? e.message : String(e),
					});
				}
			}
			return items;
		}
		case "pull_request_target":
			throw new Error(
				"pull_request_target is not supported; use pull_request and the schedule sweep",
			);
		default:
			throw new Error(`unsupported event ${name}`);
	}
}

const input = (env: NodeJS.ProcessEnv, name: string) =>
	env[`INPUT_${name}`] || undefined;

/** Everything the workflow passes in as inputs. Throws on an invalid `mode`. */
export function inputsFromEnv(env: NodeJS.ProcessEnv): {
	auth: AuthInput;
	mode?: Config["mode"];
	apiKey?: string;
} {
	return {
		auth: {
			token: input(env, "GITHUB_TOKEN"),
			appId: input(env, "APP_ID"),
			installationId: input(env, "INSTALLATION_ID"),
			privateKey: input(env, "PRIVATE_KEY"),
			botLogin: input(env, "BOT_LOGIN"),
		},
		mode: parseMode(input(env, "MODE"), "mode input"),
		apiKey: input(env, "ANTHROPIC_API_KEY"),
	};
}

/** The event name, its payload and the repository the workflow runs in. */
export function eventFromEnv(env: NodeJS.ProcessEnv) {
	const [owner, repo] = (env.GITHUB_REPOSITORY ?? "").split("/");
	if (!(owner && repo && env.GITHUB_EVENT_NAME && env.GITHUB_EVENT_PATH)) {
		throw new Error("run inside GitHub Actions");
	}
	return {
		name: env.GITHUB_EVENT_NAME,
		payload: JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) as Payload,
		repo: { owner, repo },
	};
}

async function main(env = process.env) {
	const event = eventFromEnv(env);
	const { auth, mode, apiKey } = inputsFromEnv(env);
	const items = await handleEvent(
		event.name,
		event.payload,
		{ ...(await resolveAuth(auth)), mode, llm: { apiKey } },
		event.repo,
	);
	for (const item of items) console.log(JSON.stringify(item));
	if (items.some(failed)) process.exitCode = 1;
}

if (realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	main().catch((e) => {
		console.error(e instanceof Error ? e.message : e);
		process.exit(1);
	});
}
