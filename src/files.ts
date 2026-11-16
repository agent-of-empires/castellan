import type { GithubTransport, Repo } from "./github.js";

/** One changed file's post-image text, as the model's `files` field sees it. */
export interface FileContext {
	path: string;
	text: string;
	/** True when the text was cut at the per-file cap. */
	truncated: boolean;
}

/** Files per review, characters per file, characters over all files. */
export const FILE_CAPS = { count: 6, perFile: 12_000, total: 36_000 };

const isBinary = (text: string) => text.includes("\u0000");

/** The header counts toward the field, since `renderFileContext` sends it too. */
const header = (path: string, truncated: boolean) =>
	`===== ${path}${truncated ? " (truncated)" : ""} =====\n`;

/**
 * The post-image of the changed files at `ref` (the head), in the caller's order,
 * within FILE_CAPS. At most `FILE_CAPS.count` reads are attempted, so a PR of 200
 * unreadable paths cannot make 200 sequential requests. A 404 is skipped (removed,
 * submodule, directory); any other failure throws, because a transient GitHub error
 * must not become a permanently weaker review cached for that head.
 */
export async function readFiles(
	transport: GithubTransport,
	{ owner, repo }: Repo,
	ref: string,
	paths: string[],
): Promise<FileContext[]> {
	const files: FileContext[] = [];
	let used = 0;
	for (const path of paths.slice(0, FILE_CAPS.count)) {
		if (used >= FILE_CAPS.total) break;
		let text: string;
		try {
			const { data } = await transport.request(
				"GET /repos/{owner}/{repo}/contents/{path}",
				{ owner, repo, path, ref, mediaType: { format: "raw" } },
			);
			text = data as unknown as string;
		} catch (err) {
			if ((err as { status?: number }).status === 404) continue;
			throw err;
		}
		if (typeof text !== "string" || isBinary(text)) continue;
		const room = FILE_CAPS.total - used - header(path, false).length - 2;
		const limit = Math.min(FILE_CAPS.perFile, room);
		if (limit <= 0) break;
		const truncated = text.length > limit;
		const kept = truncated ? text.slice(0, limit) : text;
		files.push({ path, text: kept, truncated });
		used += kept.length + header(path, truncated).length + 2;
	}
	return files;
}

/** The `files` prompt field: the changed files at the head, or undefined when there are none. */
export function renderFileContext(files: FileContext[]): string | undefined {
	if (!files.length) return undefined;
	return files
		.map(
			(f) =>
				`===== ${f.path}${f.truncated ? " (truncated)" : ""} =====\n${f.text}`,
		)
		.join("\n\n");
}
