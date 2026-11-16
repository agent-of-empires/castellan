/**
 * The new-file line numbers a unified diff shows, per path. A review comment can
 * only be anchored to one of these: GitHub rejects any other line.
 */
export type DiffLines = Map<string, Set<number>>;

/** The text of each added line, per path, keyed by new-side line number. */
export type DiffAdditions = Map<string, Map<number, string>>;

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function rightLines(diff: string): DiffLines {
	const out: DiffLines = new Map();
	let path: string | null = null;
	let line = 0;
	// PR content can add a line that reads `+++ b/x`, so a header is only a header
	// before the first hunk of its file; inside a hunk it is added text.
	let inHunk = false;
	const rows = diff.split("\n");
	// A diff that ends with a newline leaves an empty element that is not a line.
	if (rows.at(-1) === "") rows.pop();
	for (const raw of rows) {
		if (raw.startsWith("diff --git ")) {
			path = null;
			line = 0;
			inHunk = false;
			continue;
		}
		if (!inHunk && raw.startsWith("+++ ")) {
			// `+++ b/path`, or `+++ /dev/null` for a deletion.
			const p = raw.slice(4).split("\t")[0]?.trim() ?? "";
			const name = p.replace(/^b\//, "");
			path = !name || name === "/dev/null" ? null : name;
			if (path && !out.has(path)) out.set(path, new Set());
			continue;
		}
		if (!inHunk && raw.startsWith("--- ")) continue;
		const hunk = HUNK.exec(raw);
		if (hunk?.[1]) {
			line = Number(hunk[1]);
			inHunk = true;
			continue;
		}
		if (path === null) continue;
		// "\ No newline at end of file" is not a line of either side.
		if (raw.startsWith("\\")) continue;
		if (raw.startsWith("-")) continue;
		// Context and added lines both exist on the new side.
		out.get(path)?.add(line);
		line++;
	}
	return out;
}

/**
 * The added lines of a unified diff, with their text, so a suggestion can be
 * checked against the line it claims to replace.
 */
export function addedLines(diff: string): DiffAdditions {
	const out: DiffAdditions = new Map();
	let path: string | null = null;
	let line = 0;
	// An added source line can read `+++ b/x`, so a header only counts before the
	// first hunk of its file; inside one it is text, and a fix must not follow it.
	let inHunk = false;
	for (const raw of diff.split("\n")) {
		if (raw.startsWith("diff --git ")) {
			path = null;
			line = 0;
			inHunk = false;
			continue;
		}
		if (!inHunk && raw.startsWith("+++ ")) {
			const p = raw.slice(4).split("\t")[0]?.trim() ?? "";
			const name = p.replace(/^b\//, "");
			path = !name || name === "/dev/null" ? null : name;
			continue;
		}
		if (!inHunk && raw.startsWith("--- ")) continue;
		const hunk = HUNK.exec(raw);
		if (hunk?.[1]) {
			line = Number(hunk[1]);
			inHunk = true;
			continue;
		}
		if (path === null) continue;
		if (raw.startsWith("\\")) continue;
		if (raw.startsWith("+")) {
			const added = out.get(path) ?? new Map<number, string>();
			added.set(line, raw.slice(1));
			out.set(path, added);
			line++;
			continue;
		}
		if (raw.startsWith("-")) continue;
		line++;
	}
	return out;
}
