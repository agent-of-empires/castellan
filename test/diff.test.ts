import { describe, expect, it } from "vitest";
import { addedLines, rightLines } from "../src/diff.js";

const diff = [
	"diff --git a/src/a.ts b/src/a.ts",
	"index 111..222 100644",
	"--- a/src/a.ts",
	"+++ b/src/a.ts",
	"@@ -1,4 +1,5 @@",
	" context one",
	"-removed one",
	"+added one",
	" context two",
	"@@ -20,2 +21,3 @@",
	" context twenty one",
	"+added two",
	"\\ No newline at end of file",
	"diff --git a/gone.txt b/gone.txt",
	"deleted file mode 100644",
	"--- a/gone.txt",
	"+++ /dev/null",
	"@@ -1,2 +0,0 @@",
	"-a",
	"-b",
].join("\n");

describe("rightLines", () => {
	it("lists the new-side line numbers of every hunk", () => {
		expect([...(rightLines(diff).get("src/a.ts") ?? [])]).toEqual([
			1, 2, 3, 21, 22,
		]);
	});

	it("skips a deleted file, whose only path is /dev/null", () => {
		expect(rightLines(diff).has("gone.txt")).toBe(false);
	});

	it("does not count a removed line as a new-side line", () => {
		expect(rightLines(diff).get("src/a.ts")?.has(4)).toBe(false);
	});

	it("returns nothing for a diff with no hunk", () => {
		expect(rightLines("diff --git a/x b/x\ndiff --git a/y b/y")).toEqual(
			new Map(),
		);
	});

	it("handles a new file", () => {
		const added = [
			"diff --git a/new.ts b/new.ts",
			"new file mode 100644",
			"--- /dev/null",
			"+++ b/new.ts",
			"@@ -0,0 +1,2 @@",
			"+one",
			"+two",
		].join("\n");
		expect([...(rightLines(added).get("new.ts") ?? [])]).toEqual([1, 2]);
	});

	it("ignores lines before any file header", () => {
		expect(rightLines("+stray\n context").size).toBe(0);
	});

	it("reads a +++ line inside a hunk as added text, not a new file", () => {
		const tricky = [
			"diff --git a/x.md b/x.md",
			"--- a/x.md",
			"+++ b/x.md",
			"@@ -1,3 +1,4 @@",
			" one",
			"+++ b/evil.ts",
			"+three",
			" four",
		].join("\n");
		const lines = rightLines(tricky);
		expect(lines.has("evil.ts")).toBe(false);
		expect([...(lines.get("x.md") ?? [])]).toEqual([1, 2, 3, 4]);
	});

	it("keeps only the added lines, not the context around them", () => {
		expect([...(addedLines(diff).get("src/a.ts") ?? [])]).toEqual([2, 22]);
	});

	it("does not count a trailing newline as a new-side line", () => {
		const trailing = [
			"diff --git a/src/a.ts b/src/a.ts",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1,2 +1,3 @@",
			" one",
			"+two",
			" three",
			"",
		].join("\n");
		expect([...(rightLines(trailing).get("src/a.ts") ?? [])]).toEqual([
			1, 2, 3,
		]);
	});
});
