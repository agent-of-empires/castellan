/**
 * The new-file line numbers a unified diff shows, per path. A review comment can
 * only be anchored to one of these: GitHub rejects any other line.
 */
export type DiffLines = Map<string, Set<number>>;

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function rightLines(diff: string): DiffLines {
	const out: DiffLines = new Map();
	let path: string | null = null;
	let line = 0;
	for (const raw of diff.split("\n")) {
		if (raw.startsWith("diff --git ")) {
			path = null;
			line = 0;
			continue;
		}
		if (raw.startsWith("+++ ")) {
			// `+++ b/path`, or `+++ /dev/null` for a deletion.
			const p = raw.slice(4).split("\t")[0]?.trim() ?? "";
			const name = p.replace(/^b\//, "");
			path = !name || name === "/dev/null" ? null : name;
			if (path && !out.has(path)) out.set(path, new Set());
			continue;
		}
		if (raw.startsWith("--- ")) continue;
		const hunk = HUNK.exec(raw);
		if (hunk?.[1]) {
			line = Number(hunk[1]);
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
