/** CLI adapter: `castellan <owner/repo> <number> [--issue] [--mode m] [--dry-run]`. */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Config } from "../config.js";
import {
	dryRun,
	failed,
	type Item,
	type RunDeps,
	runForIssue,
	runForPr,
} from "../run.js";
import { resolveAuth } from "./auth.js";

const USAGE =
	"usage: castellan <owner/repo> <number> [--issue] [--mode off|shadow|enforce] [--dry-run]";
const MODES = ["off", "shadow", "enforce"];

export interface CliArgs {
	repo: { owner: string; repo: string };
	number: number;
	issue: boolean;
	dryRun: boolean;
	mode?: Config["mode"];
}

export function parseCli(argv: string[]): CliArgs {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			issue: { type: "boolean" },
			mode: { type: "string" },
			"dry-run": { type: "boolean" },
		},
	});
	const [slug = "", num = ""] = positionals;
	const [owner, repo, ...rest] = slug.split("/");
	const number = Number(num);
	if (
		!owner ||
		!repo ||
		rest.length ||
		!Number.isInteger(number) ||
		number < 1
	) {
		throw new Error(USAGE);
	}
	if (values.mode !== undefined && !MODES.includes(values.mode)) {
		throw new Error(`--mode must be one of ${MODES.join(", ")}`);
	}
	return {
		repo: { owner, repo },
		number,
		issue: values.issue ?? false,
		dryRun: values["dry-run"] ?? false,
		mode: values.mode as Config["mode"] | undefined,
	};
}

/** Returns the exit code. `--dry-run` prints the comment it would post and writes nothing. */
export async function execute(
	args: CliArgs,
	base: Omit<RunDeps, "repo" | "mode">,
	print: (text: string) => void = console.log,
): Promise<number> {
	let deps: RunDeps = { ...base, repo: args.repo, mode: args.mode };
	if (args.dryRun) deps = dryRun(deps, print);
	const result = await (args.issue ? runForIssue : runForPr)(deps, args.number);
	const item: Item = {
		kind: args.issue ? "issue" : "pr",
		number: args.number,
		result,
	};
	if (!args.dryRun || result.status !== "done") {
		print(JSON.stringify(item));
	}
	return failed(item) ? 1 : 0;
}

async function main() {
	const args = parseCli(process.argv.slice(2));
	const env = process.env;
	const auth = await resolveAuth({
		token: env.GITHUB_TOKEN,
		appId: env.CASTELLAN_APP_ID,
		installationId: env.CASTELLAN_INSTALLATION_ID,
		privateKey: env.CASTELLAN_PRIVATE_KEY,
		botLogin: env.CASTELLAN_BOT_LOGIN,
	});
	process.exitCode = await execute(args, {
		...auth,
		llm: { apiKey: env.ANTHROPIC_API_KEY },
	});
}

if (realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	main().catch((e) => {
		console.error(e instanceof Error ? e.message : e);
		process.exit(1);
	});
}
