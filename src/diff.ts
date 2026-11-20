/**
 * The new-file line numbers a unified diff shows, per path. A review comment can
 * only be anchored to one of these: GitHub rejects any other line.
 */
export type DiffLines = Map<string, Set<number>>;

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function rightLines(diff: string, addedOnly = false): DiffLines {
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
		// Context and added lines both exist on the new side; `addedOnly` keeps the added.
		if (!addedOnly || raw.startsWith("+")) out.get(path)?.add(line);
		line++;
	}
	return out;
}

/** Only the lines the diff adds, not the unchanged context around them. */
export const addedLines = (diff: string) => rightLines(diff, true);
