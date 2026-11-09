import { parse } from "yaml";
import { z } from "zod";
import type { GithubTransport, Repo } from "./github.js";

export const CONFIG_PATH = ".castellan.yml";

const base = z.strictObject({
	mode: z.enum(["off", "shadow", "enforce"]).default("shadow"),
	limits: z
		.strictObject({
			maxLines: z.number().int().positive().default(100),
			maxFiles: z.number().int().positive().default(5),
			maxTopLevelDirs: z.number().int().positive().default(2),
		})
		.prefault({}),
	paths: z
		.strictObject({
			protected: z.array(z.string()).default([]),
			release: z.array(z.string()).default([]),
			migrations: z
				.array(z.string())
				.default([
					"migrations/",
					"migration/",
					"db/migrate/",
					"alembic/versions/",
				]),
		})
		.prefault({}),
	teams: z
		.strictObject({
			maintainers: z
				.string()
				.optional()
				.describe(
					"Team slug within the installation org (the org comes from the event).",
				),
			protected: z
				.string()
				.optional()
				.describe(
					"Team slug, or org/slug (the org prefix is ignored; the org comes from the event).",
				),
		})
		.prefault({}),
	trustedAuthors: z.array(z.string()).default([]),
	skip_branches: z
		.array(z.string())
		.default(["release-staging/*", "release-plz-*"])
		.describe("Head branch globs that castellan never evaluates."),
	labels: z
		.strictObject({
			needsTriage: z.string().default("needs-triage"),
			bug: z.string().default("bug"),
			feature: z.string().default("enhancement"),
		})
		.prefault({}),
	project: z
		.strictObject({
			name: z.string().default("Agent of Empires"),
			statusField: z.string().default("Status"),
			priorityField: z.string().default("Priority"),
			sizeField: z.string().default("Size"),
			roadmapField: z.string().default("Roadmap state"),
		})
		.prefault({}),
	triage: z
		.strictObject({
			mode: z
				.enum(["off", "shadow", "enforce"])
				.optional()
				.describe("Defaults to the top-level `mode`."),
			priority_labels: z
				.array(z.string())
				.min(1)
				.default(["P0", "P1", "P2", "P3"]),
			status_by_priority: z
				.record(z.string(), z.string())
				.default({ P0: "Ready", P1: "Ready", P2: "Backlog", P3: "Backlog" }),
			roadmap_by_status: z.record(z.string(), z.string()).default({
				Ready: "📋 Planned",
				Backlog: "💡 Future / Exploring",
			}),
		})
		.prefault({}),
	llm: z
		.strictObject({
			provider: z.enum(["anthropic", "bedrock"]).default("bedrock"),
		})
		.prefault({}),
	models: z
		.strictObject({
			review: z.string().optional(),
			triage: z.string().optional(),
		})
		.prefault({}),
	prompt: z
		.strictObject({
			base: z.string().optional(),
			guidance: z.array(z.string()).default([]),
		})
		.prefault({}),
});

const BEDROCK_ID = /^(anthropic|us|global)\./;
const DEFAULT_MODELS = {
	anthropic: { review: "claude-sonnet-5-5", triage: "claude-haiku-5-5" },
	bedrock: {
		review: "us.anthropic.claude-sonnet-5-5",
		triage: "us.anthropic.claude-haiku-5-5",
	},
};

const schema = base.transform((c, ctx) => {
	const { provider } = c.llm;
	const models = { ...DEFAULT_MODELS[provider], ...stripUndefined(c.models) };
	if (provider === "bedrock") {
		for (const key of ["review", "triage"] as const) {
			if (!BEDROCK_ID.test(models[key])) {
				ctx.issues.push({
					code: "custom",
					message: `models.${key} must start with anthropic., us. or global. when llm.provider is bedrock`,
					input: models[key],
					path: ["models", key],
				});
			}
		}
	}
	for (const p of c.triage.priority_labels) {
		if (!(p in c.triage.status_by_priority)) {
			ctx.issues.push({
				code: "custom",
				message: `triage.status_by_priority has no entry for ${p}`,
				input: c.triage.status_by_priority,
				path: ["triage", "status_by_priority"],
			});
		}
	}
	return {
		...c,
		triage: { ...c.triage, mode: c.triage.mode ?? c.mode },
		models,
	};
});

function stripUndefined<T extends Record<string, string | undefined>>(o: T) {
	return Object.fromEntries(
		Object.entries(o).filter(([, v]) => v !== undefined),
	) as { [K in keyof T]?: string };
}

export type Config = z.infer<typeof schema>;

export type ConfigResult =
	| { ok: true; config: Config }
	| { ok: false; error: string };

export type ReadFile = (
	baseSha: string,
	path: string,
) => Promise<string | null>;

/** Reads the file at `baseSha`, the base commit (`pull_request.base.sha`), never the head. 404 means null; other errors throw. */
export function githubReader(
	transport: GithubTransport,
	{ owner, repo }: Repo,
): ReadFile {
	return async (baseSha, path) => {
		try {
			const { data } = await transport.request(
				"GET /repos/{owner}/{repo}/contents/{path}",
				{
					owner,
					repo,
					path,
					ref: baseSha,
					mediaType: { format: "raw" },
				},
			);
			return data as unknown as string;
		} catch (err) {
			if ((err as { status?: number }).status === 404) return null;
			throw err;
		}
	};
}

/** Reads `.castellan.yml` at `baseSha` only. `ok: false` means the caller must escalate. */
export async function loadConfig(
	baseSha: string,
	readFile: ReadFile,
): Promise<ConfigResult> {
	let raw: unknown = {};
	try {
		const text = await readFile(baseSha, CONFIG_PATH);
		if (text !== null) raw = parse(text) ?? {};
	} catch (e) {
		return { ok: false, error: `cannot read ${CONFIG_PATH}: ${String(e)}` };
	}
	const result = schema.safeParse(raw);
	if (!result.success) {
		return {
			ok: false,
			error: `invalid ${CONFIG_PATH}: ${z.prettifyError(result.error)}`,
		};
	}
	return { ok: true, config: result.data };
}
