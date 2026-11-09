import { describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import { type Context, evaluate } from "../src/rules.js";
import type { Snapshot } from "../src/snapshot.js";

const load = async (yaml = "") => {
	const r = await loadConfig("main", async () => yaml);
	if (!r.ok) throw new Error(r.error);
	return r.config;
};
const config = await load();

const file = (path: string, additions = 5, deletions = 0) => ({
	path,
	status: "modified",
	additions,
	deletions,
});

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
	title: "fix: thing",
	body: "Closes #7",
	bodyTruncated: false,
	author: "alice",
	authorClass: "maintainer",
	draft: false,
	baseRef: "main",
	baseSha: "base1",
	headRef: "fix/thing",
	headSha: "abc",
	linkedIssues: [7],
	files: [file("src/a.ts")],
	filesTruncated: false,
	diff: "",
	diffTruncated: false,
	checks: [{ name: "ci", conclusion: "success" }],
	reviews: [],
	codeRabbit: null,
	...over,
});

const ctx = (over: Partial<Context> = {}): Context => ({
	defaultBranch: "main",
	codeowners: [],
	bugIssues: [7],
	...over,
});

const run = (
	s: Snapshot,
	c: Config = config,
	required: string[] = ["ci"],
	x: Context = ctx(),
) => evaluate(s, c, required, x);

const rulesOf = (d: ReturnType<typeof run>) => d.reasons.map((r) => r.rule);

describe("baseline", () => {
	it("is a candidate", () => {
		expect(run(snap())).toEqual({ outcome: "candidate", reasons: [] });
	});
});

describe("skip rules", () => {
	const cases: [string, string, Partial<Snapshot>, string?][] = [
		["draft", "draft", { draft: true }],
		["skipped_author", "dependabot[bot]", { author: "dependabot[bot]" }],
		["non_default_base", "base", { baseRef: "release/1" }],
		["skip_branch", "head", { headRef: "release-staging/1.2" }],
		["skip_branch", "head", { headRef: "release-plz-2026-01-01" }],
	];
	it.each(cases)("%s skips (%s)", (rule, _n, over) => {
		const d = run(snap(over));
		expect(d.outcome).toBe("skip");
		expect(rulesOf(d)).toEqual([rule]);
	});

	it("skip_branch does not match other heads", () => {
		for (const headRef of ["release-staging", "feat/release-plz-x", "fix/a"]) {
			expect(run(snap({ headRef })).outcome).toBe("candidate");
		}
	});

	it("skip_branches comes from config", async () => {
		const c = await load("skip_branches: ['bot/**']");
		expect(run(snap({ headRef: "bot/a/b" }), c).outcome).toBe("skip");
		expect(run(snap({ headRef: "release-plz-1" }), c).outcome).toBe(
			"candidate",
		);
	});

	it("mode_off skips", async () => {
		const c = await load("mode: off");
		expect(rulesOf(run(snap(), c))).toEqual(["mode_off"]);
		expect(run(snap(), await load("mode: enforce")).outcome).toBe("candidate");
	});
});

describe("escalate rules", () => {
	const escalates = (
		rule: string,
		failing: Partial<Snapshot>,
		opts: { yaml?: string; required?: string[]; x?: Partial<Context> } = {},
	) =>
		it(rule, async () => {
			const c = await load(opts.yaml);
			const x = ctx(opts.x);
			const required = opts.required ?? ["ci"];
			expect(run(snap(), c, required, x).outcome).toBe("candidate");
			const d = run(snap(failing), c, required, x);
			expect(d.outcome).toBe("escalate");
			expect(rulesOf(d)[0]).toBe(rule);
		});

	escalates("castellan_config", { files: [file(".castellan.yml")] });
	escalates("github_dir", { files: [file(".github/workflows/ci.yml")] });
	escalates(
		"protected_path",
		{ files: [file("src/auth/token.ts")] },
		{ yaml: "paths: { protected: ['src/auth/**'] }" },
	);
	escalates(
		"protected_path",
		{ files: [file("infra/main.tf")] },
		{ yaml: "paths: { release: ['infra/'] }" },
	);
	escalates(
		"protected_owner",
		{ files: [file("src/core/x.ts")] },
		{
			yaml: "teams: { protected: sec }",
			x: { codeowners: [{ pattern: "/src/core/", owners: ["@org/sec"] }] },
		},
	);
	escalates("check_failing", {
		checks: [
			{ name: "ci", conclusion: "success" },
			{ name: "lint", conclusion: "failure" },
		],
	});
	escalates("check_failing", {
		checks: [{ name: "ci", conclusion: "pending" }],
	});
	escalates("required_check", { checks: [] });
	escalates("required_check", {
		checks: [{ name: "ci", conclusion: "skipped" }],
	});
	escalates("coderabbit", { codeRabbit: "CHANGES_REQUESTED" });
	escalates("max_lines", { files: [file("src/a.ts", 60, 41)] });
	escalates("max_files", {
		files: ["a", "b", "c", "d", "e", "f"].map((n) => file(`src/${n}.ts`, 1)),
	});
	escalates("max_files", { filesTruncated: true });
	escalates("max_dirs", {
		files: [file("src/a.ts", 1), file("test/a.ts", 1), file("docs/a.md", 1)],
	});
	escalates("migration", { files: [file("db/migrations/001.sql")] });
	escalates("generated_only", { files: [file("pnpm-lock.yaml")] });
	escalates("human_changes_requested", {
		reviews: [{ login: "bob", state: "CHANGES_REQUESTED", commitId: "old" }],
	});
	escalates("stacked", { body: "Stacked on #12.\n\nCloses #7" });
	escalates("author_class", { authorClass: "bot" });
});

describe("rule details", () => {
	it("castellan config escalates even if config says otherwise", async () => {
		const c = await load(
			"paths: { protected: [], release: [] }\nmode: enforce",
		);
		const d = run(snap({ files: [file(".castellan.yml")] }), c);
		expect(d.reasons).toEqual([
			{
				rule: "castellan_config",
				text: "touches .castellan.yml",
				path: ".castellan.yml",
			},
		]);
	});

	it("reports one reason per offending path", () => {
		const d = run(
			snap({ files: [file(".github/a.yml", 1), file(".github/b.yml", 1)] }),
		);
		expect(d.reasons.map((r) => r.path)).toEqual([
			".github/a.yml",
			".github/b.yml",
		]);
	});

	it("last matching CODEOWNERS rule wins", async () => {
		const c = await load("teams: { protected: sec }");
		const x = ctx({
			codeowners: [
				{ pattern: "src/core/", owners: ["@org/sec"] },
				{ pattern: "src/core/x.ts", owners: ["@org/dev"] },
			],
		});
		expect(
			run(snap({ files: [file("src/core/x.ts")] }), c, ["ci"], x).outcome,
		).toBe("candidate");
		expect(
			run(snap({ files: [file("src/core/y.ts")] }), c, ["ci"], x).outcome,
		).toBe("escalate");
	});

	it("passes skipped and neutral non-required checks", () => {
		const checks = [
			{ name: "ci", conclusion: "success" },
			{ name: "a", conclusion: "skipped" },
			{ name: "b", conclusion: "neutral" },
		];
		expect(run(snap({ checks })).outcome).toBe("candidate");
	});

	it("a later approval clears human changes requested", () => {
		const reviews = [
			{ login: "bob", state: "CHANGES_REQUESTED", commitId: "a" },
			{ login: "bob", state: "APPROVED", commitId: "b" },
			{ login: "coderabbitai[bot]", state: "CHANGES_REQUESTED", commitId: "b" },
		];
		expect(run(snap({ reviews })).outcome).toBe("candidate");
	});

	it("root files do not count as top-level dirs", () => {
		const files = [file("a.md", 1), file("b.md", 1), file("src/a.ts", 1)];
		expect(run(snap({ files })).outcome).toBe("candidate");
	});

	it("generated plus real change is not generated-only", () => {
		const files = [file("pnpm-lock.yaml", 1), file("src/a.ts", 1)];
		expect(run(snap({ files })).outcome).toBe("candidate");
	});
});

describe("author classes", () => {
	const ext = (over: Partial<Snapshot> = {}) =>
		snap({ authorClass: "external", ...over });

	it.each(["maintainer", "trusted"] as const)(
		"%s needs only size rules",
		(c) => {
			expect(run(snap({ authorClass: c, title: "feat: x" })).outcome).toBe(
				"candidate",
			);
		},
	);

	it("external fix with a linked bug is a candidate", () => {
		expect(run(ext()).outcome).toBe("candidate");
	});

	it("external feat always escalates, even with a bug link", () => {
		const d = run(ext({ title: "feat(ui): x" }));
		expect(rulesOf(d)).toEqual(["author_class"]);
		expect(d.reasons[0]?.text).toContain("feat");
	});

	it("external non-fix title escalates", () => {
		expect(rulesOf(run(ext({ title: "chore: x" })))).toEqual(["author_class"]);
	});

	it("external fix without a bug-labeled linked issue escalates", () => {
		expect(rulesOf(run(ext({ linkedIssues: [] })))).toEqual(["author_class"]);
		expect(rulesOf(run(ext({ linkedIssues: [8] })))).toEqual(["author_class"]);
	});
});

describe("order", () => {
	const everything = snap({
		draft: true,
		baseRef: "release/1",
		headRef: "release-plz-1",
		authorClass: "bot",
		title: "feat: x",
		body: "Stacked on #1",
		codeRabbit: "CHANGES_REQUESTED",
		checks: [{ name: "ci", conclusion: "failure" }],
		files: [file(".castellan.yml", 500), file(".github/a.yml")],
		reviews: [{ login: "bob", state: "CHANGES_REQUESTED", commitId: "a" }],
	});

	it("skip beats escalate", () => {
		expect(rulesOf(run(everything))).toEqual(["draft"]);
	});

	it("walks the pipeline in RFC order, one hit at a time", () => {
		const steps: [string, Partial<Snapshot>][] = [
			["draft", { draft: false }],
			["non_default_base", { baseRef: "main" }],
			["skip_branch", { headRef: "fix/x" }],
			["castellan_config", { files: [file(".github/a.yml", 500)] }],
			["github_dir", { files: [file("src/a.ts", 500)] }],
			["check_failing", { checks: [{ name: "ci", conclusion: "success" }] }],
			["coderabbit", { codeRabbit: null }],
			["max_lines", { files: [file("src/a.ts", 1)] }],
			["human_changes_requested", { reviews: [] }],
			["stacked", { body: "" }],
			["author_class", { authorClass: "maintainer" }],
		];
		let s = everything;
		for (const [rule, fix] of steps) {
			expect(rulesOf(run(s))[0]).toBe(rule);
			s = { ...s, ...fix };
		}
		expect(run(s).outcome).toBe("candidate");
	});

	it("mode off comes after the other skip rules and before escalation", async () => {
		const c = await load("mode: off");
		const s = snap({ files: [file(".castellan.yml")] });
		expect(rulesOf(run(s, c))).toEqual(["mode_off"]);
		expect(rulesOf(run({ ...s, draft: true }, c))).toEqual(["draft"]);
	});
});
