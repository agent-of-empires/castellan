/** GitHub Action adapter. Reads the event from GITHUB_EVENT_PATH and credentials from INPUT_* (see action.yml). */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import {
	failed,
	type Item,
	type RunDeps,
	runForIssue,
	runForPr,
	sweep,
} from "../run.js";
import { resolveAuth } from "./auth.js";

interface Payload {
	pull_request?: { number: number };
	issue?: { number: number };
}

/** `pull_request_target` is refused: it hands write secrets to code from a fork. */
export async function handleEvent(
	name: string,
	payload: Payload,
	deps: RunDeps,
): Promise<Item[]> {
	switch (name) {
		case "pull_request": {
			const number = payload.pull_request?.number;
			if (!number) throw new Error("event has no pull_request.number");
			return [{ kind: "pr", number, result: await runForPr(deps, number) }];
		}
		case "issues": {
			const number = payload.issue?.number;
			if (!number) throw new Error("event has no issue.number");
			return [
				{ kind: "issue", number, result: await runForIssue(deps, number) },
			];
		}
		case "schedule":
		case "workflow_dispatch":
			return sweep(deps);
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

async function main(env = process.env) {
	const [owner, repo] = (env.GITHUB_REPOSITORY ?? "").split("/");
	if (!(owner && repo && env.GITHUB_EVENT_NAME && env.GITHUB_EVENT_PATH)) {
		throw new Error("run inside GitHub Actions");
	}
	const auth = await resolveAuth({
		token: input(env, "GITHUB_TOKEN"),
		appId: input(env, "APP_ID"),
		installationId: input(env, "INSTALLATION_ID"),
		privateKey: input(env, "PRIVATE_KEY"),
		botLogin: input(env, "BOT_LOGIN"),
	});
	const items = await handleEvent(
		env.GITHUB_EVENT_NAME,
		JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")),
		{
			...auth,
			repo: { owner, repo },
			mode: input(env, "MODE") as Config["mode"] | undefined,
			llm: { apiKey: input(env, "ANTHROPIC_API_KEY") },
		},
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
