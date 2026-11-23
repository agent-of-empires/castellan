import { z } from "zod";
import {
	type OkReviewResult,
	type ReviewResult,
	reasonSchema,
	storedVerdictSchema,
	type Verdict,
} from "./llm.js";
import type { RequestPart } from "./reviewers.js";

const blockSchema = z.strictObject({
	v: z.literal(1),
	verdict: z.enum(["merge", "escalate"]),
	headSha: z.string(),
	promptHash: z.string(),
	model: z.string(),
	/** `threadsKey` of the unresolved threads the verdict answered; absent on an older block. */
	threads: z.string().optional(),
	/** Thread-driven model runs already spent on this head; bounds a commenter's leverage. */
	threadReruns: z.number().int().min(0).optional(),
	/** Head SHA whose escalation already asked for reviewers, so a sweep does not ask again. */
	requested: z.string().optional(),
	/** Findings carried to the next head, kept even when a head's model run failed. */
	carry: z
		.strictObject({ sha: z.string(), reasons: z.array(reasonSchema) })
		.optional(),
	/** Which halves of that request landed, so a rejected half is not retried for the other. */
	requestedParts: z
		.array(
			z.custom<RequestPart>(
				(v) =>
					typeof v === "string" && (v === "users" || v.startsWith("team:")),
			),
		)
		.optional(),
	llm: z
		.strictObject({
			ok: z.literal(true),
			verdict: storedVerdictSchema,
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
	/** Changes when a review thread appears, is resolved or goes stale. */
	threads?: string;
	/** Persisted with the block; it is not part of the cache key match. */
	threadReruns?: number;
	/** Head SHA whose escalation already asked for reviewers. */
	requested?: string;
	/** Findings carried forward from an earlier head. */
	carry?: { sha: string; reasons: Verdict["reasons"] };
	/** The halves of that request that landed; the team half names its slug. */
	requestedParts?: RequestPart[];
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
 * `skipModel` PRs never reach the LLM. A cache hit needs headSha, promptHash,
 * model and threads to all match; any other change runs fresh. A block written
 * before `threads` existed never matches, which re-runs once and fails safe.
 * The caller must only persist `ok: true`.
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
		cached.model === key.model &&
		cached.threads === key.threads
	) {
		return {
			source: "cache",
			result: { ...cached.llm, promptHash: key.promptHash },
		};
	}
	return { source: "llm", result: await run() };
}
