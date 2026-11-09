import { z } from "zod";
import {
	type OkReviewResult,
	type ReviewResult,
	verdictSchema,
} from "./llm.js";

const blockSchema = z.strictObject({
	v: z.literal(1),
	verdict: z.enum(["merge", "escalate"]),
	headSha: z.string(),
	promptHash: z.string(),
	model: z.string(),
	llm: z
		.strictObject({
			ok: z.literal(true),
			verdict: verdictSchema,
			usage: z.strictObject({
				inputTokens: z.number(),
				outputTokens: z.number(),
			}),
			costUsd: z.number(),
		})
		.optional(),
});

/** The hidden JSON in the sticky comment. `llm` only ever holds a successful result; its promptHash is the block's. */
export type CacheBlock = Omit<z.infer<typeof blockSchema>, "v" | "llm"> & {
	llm?: Omit<OkReviewResult, "promptHash">;
};

export interface CacheKey {
	headSha: string;
	promptHash: string;
	model: string;
}

export const MARKER = "<!-- castellan";
// The real block is always the last thing in the body.
const BLOCK = /<!-- castellan (\{.*?\}) -->\s*$/s;

export function serializeBlock(block: CacheBlock): string {
	// Escape "<" and ">" so model text can neither close the comment early nor forge a marker,
	// and dashes so the comment stays dash free. All stay valid JSON.
	const json = JSON.stringify({ v: 1, ...block }).replace(
		/[<>\u2013\u2014]/g,
		(c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
	return `<!-- castellan ${json} -->`;
}

/** Returns null when the block is absent or malformed; the caller then runs fresh. */
export function parseBlock(commentBody: string): CacheBlock | null {
	// More than one marker means someone injected a block; trust none.
	if (commentBody.split(MARKER).length > 2) return null;
	const json = BLOCK.exec(commentBody)?.[1];
	if (!json) return null;
	try {
		const { v: _v, ...block } = blockSchema.parse(JSON.parse(json));
		return block;
	} catch {
		return null;
	}
}

/**
 * `costUsd` on a `cache` result is the original call's cost and must not be counted again.
 */
export type Dedup =
	| { source: "cache" | "llm"; result: ReviewResult }
	| { source: "skipped" };

/**
 * `skipModel` PRs never reach the LLM. A cache hit needs headSha, promptHash and
 * model to all match; any other change runs fresh. The caller must only persist `ok: true`.
 */
export async function getOrRun(opts: {
	cached: CacheBlock | null;
	key: CacheKey;
	skipModel: boolean;
	run: () => Promise<ReviewResult>;
}): Promise<Dedup> {
	const { cached, key, skipModel, run } = opts;
	if (skipModel) return { source: "skipped" };
	if (
		cached?.llm &&
		cached.headSha === key.headSha &&
		cached.promptHash === key.promptHash &&
		cached.model === key.model
	) {
		return {
			source: "cache",
			result: { ...cached.llm, promptHash: key.promptHash },
		};
	}
	return { source: "llm", result: await run() };
}
