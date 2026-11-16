import { describe, expect, it, vi } from "vitest";
import { FILE_CAPS, readFiles, renderFileContext } from "../src/files.js";
import type { GithubTransport } from "../src/github.js";

const repo = { owner: "o", repo: "r" };

function transport(files: Record<string, string | Error>): GithubTransport {
	return {
		request: vi.fn(async (_route: string, params: Record<string, unknown>) => {
			const content = files[String(params.path)];
			if (content === undefined || content instanceof Error)
				throw { status: 404 };
			return { data: content };
		}),
	} as unknown as GithubTransport;
}

describe("readFiles", () => {
	it("reads each file at the given ref, in order", async () => {
		const t = transport({ "src/a.ts": "const a = 1;\n", "src/b.ts": "b\n" });
		const files = await readFiles(t, repo, "head1", ["src/a.ts", "src/b.ts"]);
		expect(files).toEqual([
			{ path: "src/a.ts", text: "const a = 1;\n", truncated: false },
			{ path: "src/b.ts", text: "b\n", truncated: false },
		]);
		expect(t.request).toHaveBeenCalledWith(
			"GET /repos/{owner}/{repo}/contents/{path}",
			expect.objectContaining({
				path: "src/a.ts",
				ref: "head1",
				mediaType: { format: "raw" },
			}),
		);
	});

	it("skips a 404 and keeps the rest", async () => {
		const t = transport({ "src/a.ts": new Error("404"), "src/b.ts": "b\n" });
		const files = await readFiles(t, repo, "head1", ["src/a.ts", "src/b.ts"]);
		expect(files.map((f) => f.path)).toEqual(["src/b.ts"]);
	});

	it("throws on a failure that is not a 404, so the run fails closed", async () => {
		const t = {
			request: vi.fn(async () => {
				throw Object.assign(new Error("rate limited"), { status: 403 });
			}),
		} as unknown as GithubTransport;
		await expect(readFiles(t, repo, "head1", ["src/a.ts"])).rejects.toThrow(
			"rate limited",
		);
	});

	it("attempts at most the file count, not the kept files", async () => {
		const t = {
			request: vi.fn(async () => {
				throw { status: 404 };
			}),
		} as unknown as GithubTransport;
		const paths = Array.from({ length: 200 }, (_, i) => `src/f${i}.ts`);
		await readFiles(t, repo, "head1", paths);
		expect(t.request).toHaveBeenCalledTimes(FILE_CAPS.count);
	});

	it("skips binary content", async () => {
		const t = transport({ "logo.png": "\u0000PNG", "src/a.ts": "a\n" });
		const files = await readFiles(t, repo, "head1", ["logo.png", "src/a.ts"]);
		expect(files.map((f) => f.path)).toEqual(["src/a.ts"]);
	});

	it("cuts a long file at the per-file cap and marks it", async () => {
		const t = transport({ "big.ts": "x".repeat(FILE_CAPS.perFile + 10) });
		const [file] = await readFiles(t, repo, "head1", ["big.ts"]);
		expect(file?.truncated).toBe(true);
		expect(file?.text).toHaveLength(FILE_CAPS.perFile);
	});

	it("stops at the file count cap", async () => {
		const paths = Array.from(
			{ length: FILE_CAPS.count + 3 },
			(_, i) => `${i}.ts`,
		);
		const t = transport(Object.fromEntries(paths.map((p) => [p, "x"])));
		expect(await readFiles(t, repo, "head1", paths)).toHaveLength(
			FILE_CAPS.count,
		);
	});

	it("stops at the total cap", async () => {
		const t = transport({
			"a.ts": "x".repeat(FILE_CAPS.perFile),
			"b.ts": "x".repeat(FILE_CAPS.perFile),
			"c.ts": "x".repeat(FILE_CAPS.perFile),
			"d.ts": "x".repeat(FILE_CAPS.perFile),
		});
		const files = await readFiles(t, repo, "head1", [
			"a.ts",
			"b.ts",
			"c.ts",
			"d.ts",
		]);
		const total = files.reduce((n, f) => n + f.text.length, 0);
		expect(total).toBeLessThanOrEqual(FILE_CAPS.total);
		expect(files).toHaveLength(3);
	});
});

describe("renderFileContext", () => {
	it("is undefined without files", () => {
		expect(renderFileContext([])).toBeUndefined();
	});

	it("headers each file, marking truncation", () => {
		expect(
			renderFileContext([
				{ path: "src/a.ts", text: "a\n", truncated: false },
				{ path: "src/b.ts", text: "b\n", truncated: true },
			]),
		).toBe(
			"===== src/a.ts =====\na\n\n\n===== src/b.ts (truncated) =====\nb\n",
		);
	});
});
