import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const reader = (text: string | null) => async () => text;

describe("loadConfig", () => {
	it("parses a full file", async () => {
		const r = await loadConfig(
			"main",
			reader(`
mode: enforce
limits: { maxLines: 50, maxFiles: 3, maxTopLevelDirs: 1 }
paths: { protected: ["src/auth/**"], release: [".github/**"] }
teams: { maintainers: org/maint, protected: org/sec }
trustedAuthors: [klubrake]
labels: { needsTriage: triage, bug: defect }
project: { statusField: S, priorityField: P, sizeField: Z, roadmapField: R }
models: { review: m1, triage: m2 }
prompt: { base: be strict, guidance: ["no em dashes"] }
`),
		);
		expect(r).toMatchObject({
			ok: true,
			config: {
				mode: "enforce",
				limits: { maxLines: 50 },
				trustedAuthors: ["klubrake"],
				prompt: { guidance: ["no em dashes"] },
			},
		});
	});

	it("fills defaults for a partial file", async () => {
		const r = await loadConfig(
			"main",
			reader("trustedAuthors: [a]\nlimits: { maxFiles: 2 }"),
		);
		expect(r).toMatchObject({
			ok: true,
			config: {
				mode: "shadow",
				limits: { maxLines: 100, maxFiles: 2, maxTopLevelDirs: 2 },
				labels: { bug: "bug" },
				trustedAuthors: ["a"],
			},
		});
	});

	it.each([null, "", "# nothing"])("uses defaults for %j", async (text) => {
		const r = await loadConfig("main", reader(text));
		expect(r).toMatchObject({ ok: true, config: { mode: "shadow" } });
	});

	it.each([
		["bad enum", "mode: yolo"],
		["bad type", "limits: { maxLines: lots }"],
		["unknown key", "mod: off"],
		["not a mapping", "- a\n- b"],
		["bad yaml", "a: [unclosed"],
	])("fails closed on %s", async (_name, text) => {
		const r = await loadConfig("main", reader(text));
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toContain(".castellan.yml");
	});

	it("fails closed when the read throws", async () => {
		const r = await loadConfig("main", async () => {
			throw new Error("boom");
		});
		expect(r).toMatchObject({ ok: false });
	});

	it("reads from the base ref only", async () => {
		const calls: string[][] = [];
		await loadConfig("base-sha", async (ref, path) => {
			calls.push([ref, path]);
			return null;
		});
		expect(calls).toEqual([["base-sha", ".castellan.yml"]]);
	});
});
