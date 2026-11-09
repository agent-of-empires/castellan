import { z } from "zod";
import type { ReviewResult } from "./llm.js";

type OkResult = Extract<ReviewResult, { ok: true }>;

const llmSchema = z.strictObject({
	ok: z.literal(true),
	verdict: z.strictObject({
		intent_match: z.boolean(),
		new_behavior: z.boolean(),
		reasons: z.array(
			z.strictObject({
				severity: z.enum(["blocker", "concern", "nit"]),
				text: z.string(),
				path: z.string().optional(),
			}),
		),
	}),
	usage: z.strictObject({ inputTokens: z.number(), outputTokens: z.number() }),
	costUsd: z.number(),
	promptHash: z.string(),
});

const blockSchema = z.strictObject({
	verdict: z.enum(["merge", "escalate"]),
	headSha: z.string(),
	promptHash: z.string(),
	model: z.string(),
	llm: llmSchema.optional(),
});

/** The hidden JSON in the sticky comment. `llm` only ever holds a successful result. */
export type CacheBlock = Omit<z.infer<typeof blockSchema>, "llm"> & {
	llm?: OkResult;
};

export interface CacheKey {
	headSha: string;
	promptHash: string;
	model: string;
}

const BLOCK = /<!-- castellan (\{.*?\}) -->/s;

export function serializeBlock(block: CacheBlock): string {
	// Escape ">" so model text can never close the HTML comment early.
	const json = JSON.stringify(block).replaceAll(">", "\\u003e");
	return `<!-- castellan ${json} -->`;
}

/** Returns null when the block is absent or malformed; the caller then runs fresh. */
export function parseBlock(commentBody: string): CacheBlock | null {
	const json = BLOCK.exec(commentBody)?.[1];
	if (!json) return null;
	try {
		return blockSchema.parse(JSON.parse(json));
	} catch {
		return null;
	}
}

export type Dedup =
	| { source: "cache" | "llm"; result: ReviewResult }
	| { source: "skipped" };

/**
 * Rule-escalated PRs never reach the LLM. A cache hit needs headSha, promptHash and
 * model to all match; any other change runs fresh. The caller must only persist `ok: true`.
 */
export async function getOrRun(opts: {
	cached: CacheBlock | null;
	key: CacheKey;
	ruleEscalated: boolean;
	run: () => Promise<ReviewResult>;
}): Promise<Dedup> {
	const { cached, key, ruleEscalated, run } = opts;
	if (ruleEscalated) return { source: "skipped" };
	if (
		cached?.llm &&
		cached.headSha === key.headSha &&
		cached.promptHash === key.promptHash &&
		cached.model === key.model
	) {
		return { source: "cache", result: cached.llm };
	}
	return { source: "llm", result: await run() };
}
