import { parse } from "yaml";
import { z } from "zod";

export const CONFIG_PATH = ".castellan.yml";

const schema = z.strictObject({
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
		})
		.prefault({}),
	teams: z
		.strictObject({
			maintainers: z.string().optional(),
			protected: z.string().optional(),
		})
		.prefault({}),
	trustedAuthors: z.array(z.string()).default([]),
	labels: z
		.strictObject({
			needsTriage: z.string().default("needs-triage"),
			bug: z.string().default("bug"),
		})
		.prefault({}),
	project: z
		.strictObject({
			statusField: z.string().default("Status"),
			priorityField: z.string().default("Priority"),
			sizeField: z.string().default("Size"),
			roadmapField: z.string().default("Roadmap"),
		})
		.prefault({}),
	models: z
		.strictObject({
			review: z.string().default("claude-sonnet-5-5"),
			triage: z.string().default("claude-haiku-5-5"),
		})
		.prefault({}),
	prompt: z
		.strictObject({
			base: z.string().optional(),
			guidance: z.array(z.string()).default([]),
		})
		.prefault({}),
});

export type Config = z.infer<typeof schema>;

export type ConfigResult =
	| { ok: true; config: Config }
	| { ok: false; error: string };

export type ReadFile = (ref: string, path: string) => Promise<string | null>;

/** Reads `.castellan.yml` at `baseRef` only. `ok: false` means the caller must escalate. */
export async function loadConfig(
	baseRef: string,
	readFile: ReadFile,
): Promise<ConfigResult> {
	let raw: unknown = {};
	try {
		const text = await readFile(baseRef, CONFIG_PATH);
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
