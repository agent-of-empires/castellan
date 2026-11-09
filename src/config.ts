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
			enabled: z.boolean().default(true),
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
	return { ...c, models };
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

export type ReadFile = (ref: string, path: string) => Promise<string | null>;

/** Reads the file at `ref`, the base branch (`pull_request.base.ref`), never the head. 404 means null; other errors throw. */
export function githubReader(
	transport: GithubTransport,
	{ owner, repo }: Repo,
): ReadFile {
	return async (ref, path) => {
		try {
			const { data } = await transport.request(
				"GET /repos/{owner}/{repo}/contents/{path}",
				{
					owner,
					repo,
					path,
					ref,
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

type Doc = Record<string, unknown>;

const isDoc = (v: unknown): v is Doc =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** Parses one YAML document into a mapping; empty means `{}`. */
export function parseDoc(text: string, label: string): Doc {
	const raw = parse(text) ?? {};
	if (!isDoc(raw)) throw new Error(`${label} must be a YAML mapping`);
	return raw;
}

/** Drops the `!` marker from every key. Used where there is nothing below to replace. */
function unmark(v: unknown): unknown {
	if (!isDoc(v)) return v;
	return Object.fromEntries(
		Object.entries(v).map(([k, x]) => [k.replace(/!$/, ""), unmark(x)]),
	);
}

/** Throws on a `key!` anywhere in a document that has no layer below it. */
export function assertNoReplace(doc: unknown, label: string, path = "") {
	if (!isDoc(doc)) return;
	for (const [k, v] of Object.entries(doc)) {
		if (k.endsWith("!")) {
			throw new Error(
				`${label}: ${path}${k} replaces a lower layer, but there is none below`,
			);
		}
		assertNoReplace(v, label, `${path}${k}.`);
	}
}

/** Raw merge of two layers: objects recurse, arrays append with exact dedupe, `key!` replaces, scalars take the upper. */
export function mergeDocs(lower: Doc, upper: Doc): Doc {
	const out: Doc = { ...lower };
	for (const [k, v] of Object.entries(upper)) {
		const replace = k.endsWith("!");
		const key = replace ? k.slice(0, -1) : k;
		if (replace && key in upper) {
			throw new Error(`both ${key} and ${k} are set in one document`);
		}
		const below = out[key];
		out[key] =
			replace || below === undefined
				? unmark(v)
				: isDoc(below) && isDoc(v)
					? mergeDocs(below, v)
					: Array.isArray(below) && Array.isArray(v)
						? [...new Set([...below, ...v])]
						: v;
	}
	return out;
}

/**
 * Reads `.castellan.yml` at `ref` only, on top of the already merged lower layer `below`, if any.
 * `ok: false` means the caller must escalate.
 */
export async function loadConfig(
	ref: string,
	readFile: ReadFile,
	below?: Doc,
): Promise<ConfigResult> {
	let raw: unknown = {};
	try {
		const text = await readFile(ref, CONFIG_PATH);
		if (below) {
			raw = mergeDocs(below, text === null ? {} : parseDoc(text, CONFIG_PATH));
		} else if (text !== null) {
			raw = parse(text) ?? {};
		}
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
