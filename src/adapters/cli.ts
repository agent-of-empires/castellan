/** CLI adapter: `castellan <owner/repo> <number> [--issue] [--mode m] [--dry-run]`. */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { renderComment } from "../comment.js";
import type { Config } from "../config.js";
import type { GithubTransport } from "../github.js";
import { type Env, evaluatePull, triageIssue } from "../pipeline.js";
import { type AuthInput, parseMode, resolveAuth } from "./auth.js";
import { failed } from "./result.js";

export const USAGE =
	"usage: castellan <owner/repo> <number> [--issue] [--mode off|shadow|enforce] [--dry-run]";

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
	return {
		repo: { owner, repo },
		number,
		issue: values.issue ?? false,
		dryRun: values["dry-run"] ?? false,
		mode: parseMode(values.mode, "--mode"),
	};
}

/**
 * Reads pass through; a REST write is swallowed and its body printed, and a
 * GraphQL mutation throws. A second net under `dryRun: true`, which already skips writes.
 */
export function guarded(
	transport: GithubTransport,
	print: (text: string) => void,
): GithubTransport {
	const request = async (route: string, params?: { body?: string }) => {
		if (route.startsWith("GET ")) {
			return transport.request(route as never, params as never);
		}
		if (params?.body) print(params.body);
		return { data: { id: 0, html_url: "" } };
	};
	return {
		request: request as unknown as GithubTransport["request"],
		paginate: transport.paginate,
		graphql: ((query: string, variables?: Record<string, unknown>) => {
			if (/^\s*mutation\b/.test(query)) {
				throw new Error("dry run refuses GraphQL mutations");
			}
			return transport.graphql(query, variables);
		}) as GithubTransport["graphql"],
	};
}

/** Returns the exit code. `--dry-run` forces shadow, writes nothing and prints the brief it would have posted. */
export async function execute(
	args: CliArgs,
	base: Pick<Env, "transport" | "login" | "llm">,
	print: (text: string) => void = console.log,
): Promise<number> {
	const env: Env = args.dryRun
		? { ...base, mode: "shadow", transport: guarded(base.transport, print) }
		: { ...base, mode: args.mode };
	const opts = { dryRun: args.dryRun };
	const result = args.issue
		? await triageIssue(env, args.repo, args.number, opts)
		: await evaluatePull(env, args.repo, args.number, opts);
	print(
		typeof result === "object" && "brief" in result && result.brief
			? renderComment(result.brief)
			: JSON.stringify(result),
	);
	return failed({
		kind: args.issue ? "issue" : "pr",
		number: args.number,
		result,
	})
		? 1
		: 0;
}

export function authFromEnv(env: NodeJS.ProcessEnv): AuthInput {
	return {
		token: env.GITHUB_TOKEN,
		appId: env.CASTELLAN_APP_ID,
		installationId: env.CASTELLAN_INSTALLATION_ID,
		privateKey: env.CASTELLAN_PRIVATE_KEY,
		botLogin: env.CASTELLAN_BOT_LOGIN,
	};
}

/** Returns the exit code. Help and bad arguments are handled before any credential is read. */
export async function cli(
	argv: string[],
	env: NodeJS.ProcessEnv,
	print: (text: string) => void = console.log,
): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		print(USAGE);
		return 0;
	}
	const args = parseCli(argv);
	const auth = await resolveAuth(authFromEnv(env));
	return execute(
		args,
		{ ...auth, llm: { apiKey: env.ANTHROPIC_API_KEY } },
		print,
	);
}

if (realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
	cli(process.argv.slice(2), process.env)
		.then((code) => {
			process.exitCode = code;
		})
		.catch((e) => {
			console.error(e instanceof Error ? e.message : e);
			process.exit(1);
		});
}
