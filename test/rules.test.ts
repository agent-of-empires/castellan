import { describe, expect, it } from "vitest";
import { type Config, loadConfig } from "../src/config.js";
import { type Context, evaluate, RULE_IDS } from "../src/rules.js";
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
	mergeable: true,
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

const NOW = Date.parse("2026-01-01T12:00:00Z");
const ago = (minutes: number) => NOW - minutes * 60_000;

const ctx = (over: Partial<Context> = {}): Context => ({
	now: NOW,
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

describe("stale checks", () => {
	const running = (minutes: number, name = "docs") => ({
		name,
		conclusion: "in_progress",
		startedAt: ago(minutes),
	});

	it("a non-required run in progress for 59 minutes still waits", () => {
		const d = run(snap({ checks: [...snap().checks, running(59)] }));
		expect(d.outcome).toBe("wait");
	});

	it("a non-required run in progress for 61 minutes neither waits nor escalates", () => {
		const d = run(snap({ checks: [...snap().checks, running(61)] }));
		expect(d).toEqual({ outcome: "candidate", reasons: [] });
	});

	it("a run with no start time is never stale", () => {
		const d = run(
			snap({
				checks: [
					...snap().checks,
					{ name: "docs", conclusion: "queued", startedAt: null },
				],
			}),
		);
		expect(d.outcome).toBe("wait");
	});

	it("the limit comes from limits.staleCheckMinutes", async () => {
		const c = await load("limits: { staleCheckMinutes: 10 }");
		const s = snap({ checks: [...snap().checks, running(11)] });
		expect(run(s, c).outcome).toBe("candidate");
	});

	it("a required run stale for 61 minutes escalates and names the check", () => {
		const d = run(
			snap({
				checks: [
					running(61, "ci"),
					{ name: "docs", conclusion: "queued", startedAt: ago(1) },
				],
			}),
		);
		expect(d.outcome).toBe("escalate");
		expect(rulesOf(d)).toEqual(["required_check_stale"]);
		expect(d.reasons[0]?.text).toBe(
			"required check ci is stale (in_progress for more than 60 min)",
		);
	});
});

describe("same-name runs on one sha", () => {
	const older = (conclusion: string, minutes?: number) => ({
		id: 1,
		name: "ci",
		conclusion,
		startedAt: minutes === undefined ? null : ago(minutes),
	});
	const newer = (conclusion: string, minutes?: number) => ({
		id: 2,
		name: "ci",
		conclusion,
		startedAt: minutes === undefined ? null : ago(minutes),
	});

	it("a fresh pending run waits even when a newer run passed", () => {
		const d = run(
			snap({ checks: [older("in_progress", 2), newer("success")] }),
		);
		expect(d.outcome).toBe("wait");
		expect(rulesOf(d)).toEqual(["ci_unsettled"]);
	});

	it("a stale required run is skipped and the newer pass decides", () => {
		const d = run(
			snap({ checks: [older("in_progress", 61), newer("success")] }),
		);
		expect(d).toEqual({ outcome: "candidate", reasons: [] });
	});

	it("a stale required run is skipped whatever the list order", () => {
		const d = run(
			snap({ checks: [newer("success"), older("in_progress", 61)] }),
		);
		expect(d.outcome).toBe("candidate");
	});

	it("a stale required run with a newer fresh pending run waits", () => {
		const d = run(
			snap({ checks: [older("in_progress", 61), newer("in_progress", 2)] }),
		);
		expect(rulesOf(d)).toEqual(["ci_unsettled"]);
	});

	it("a stale required run with a newer failed run escalates via the failed required check", () => {
		const d = run(
			snap({ checks: [older("in_progress", 61), newer("failure")] }),
		);
		expect(d.outcome).toBe("escalate");
		expect(rulesOf(d)).toEqual(["required_check"]);
	});

	it("a stale required run with a newer stale run escalates as stale", () => {
		const d = run(
			snap({ checks: [older("in_progress", 90), newer("in_progress", 61)] }),
		);
		expect(rulesOf(d)).toEqual(["required_check_stale"]);
		expect(d.reasons).toHaveLength(1);
	});

	it("a newer run of another name does not excuse a stale required run", () => {
		const d = run(
			snap({
				checks: [
					older("in_progress", 61),
					{ id: 2, name: "docs", conclusion: "success" },
				],
			}),
		);
		expect(rulesOf(d)).toEqual(["required_check_stale"]);
	});

	it("a stale required run with no id is not excused, newer is unproven", () => {
		const d = run(
			snap({
				checks: [
					{ name: "ci", conclusion: "in_progress", startedAt: ago(61) },
					newer("success"),
				],
			}),
		);
		expect(rulesOf(d)).toEqual(["required_check_stale"]);
	});

	it("a stale non-required run with a newer pass does not block", () => {
		const d = run(
			snap({
				checks: [
					{ id: 1, name: "ci", conclusion: "success" },
					{
						id: 2,
						name: "docs",
						conclusion: "in_progress",
						startedAt: ago(61),
					},
					{ id: 3, name: "docs", conclusion: "success" },
				],
			}),
		);
		expect(d).toEqual({ outcome: "candidate", reasons: [] });
	});

	it("an older failed run still escalates next to a newer pass", () => {
		const d = run(snap({ checks: [older("failure"), newer("success")] }));
		expect(rulesOf(d)).toContain("check_failing");
	});
});

describe("wait", () => {
	const waits = (over: Partial<Snapshot>, required = ["ci"]) => {
		const d = run(snap(over), config, required);
		expect(d.outcome).toBe("wait");
		expect(rulesOf(d)).toEqual(d.reasons.map(() => "ci_unsettled"));
	};

	it("waits when a required check has no run yet", () => {
		waits({ checks: [] });
	});

	it("waits while a required check is running and the rest passed", () => {
		waits({
			checks: [
				{ name: "ci", conclusion: "in_progress" },
				{ name: "lint", conclusion: "success" },
			],
		});
	});

	it("waits for an optional check that is queued", () => {
		waits({
			checks: [
				{ name: "ci", conclusion: "success" },
				{ name: "docs", conclusion: "queued" },
			],
		});
	});

	for (const conclusion of ["pending", "queued", "in_progress"]) {
		it(`waits on ${conclusion}`, () => {
			waits({ checks: [{ name: "ci", conclusion }] });
		});
	}

	it("beats the escalate rules", () => {
		waits({ checks: [], files: [file(".github/workflows/ci.yml")] });
	});

	it("is beaten by the skip rules", () => {
		expect(run(snap({ checks: [], draft: true })).outcome).toBe("skip");
	});

	it("escalates a settled PR with a failed required check", () => {
		const d = run(snap({ checks: [{ name: "ci", conclusion: "failure" }] }));
		expect(d.outcome).toBe("escalate");
		expect(d.reasons).toContainEqual({
			rule: "required_check",
			text: "required check ci did not pass",
		});
	});

	it("escalates merge_conflict instead of waiting", () => {
		const d = run(snap({ checks: [], mergeable: false }));
		expect(d.outcome).toBe("escalate");
		expect(rulesOf(d)).toEqual(["merge_conflict"]);
	});

	it("does not treat an unknown mergeable as a conflict", () => {
		expect(run(snap({ mergeable: null })).outcome).toBe("candidate");
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
	for (const path of ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"]) {
		escalates("codeowners_file", { files: [file(path)] });
	}
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
	for (const team of ["sec", "org/sec"]) {
		escalates(
			"protected_owner",
			{ files: [file("src/core/x.ts")] },
			{
				yaml: `teams: { protected: ${team} }`,
				x: { codeowners: [{ pattern: "/src/core/", owners: ["@org/sec"] }] },
			},
		);
	}
	escalates("check_failing", {
		checks: [
			{ name: "ci", conclusion: "success" },
			{ name: "lint", conclusion: "failure" },
		],
	});
	escalates("required_check", {
		checks: [{ name: "ci", conclusion: "cancelled" }],
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
	escalates("diff_truncated", { diffTruncated: true });
	escalates("body_truncated", { bodyTruncated: true });
	escalates("migration", { files: [file("db/migrations/001.sql")] });
	escalates(
		"migration",
		{ files: [file("sql/001.sql")] },
		{ yaml: "paths: { migrations: ['sql/'] }" },
	);
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

	it.each(["failure", "cancelled", "timed_out", "action_required", "stale"])(
		"required check concluding %s escalates",
		(conclusion) => {
			const d = run(snap({ checks: [{ name: "ci", conclusion }] }));
			expect(d.outcome).toBe("escalate");
		},
	);

	it("treats a skipped required check as satisfied, like GitHub", () => {
		const checks = [
			{ name: "Cargo Test (macos)", conclusion: "skipped" },
			{ name: "macOS gate", conclusion: "success" },
		];
		const d = run(snap({ checks }), config, [
			"Cargo Test (macos)",
			"macOS gate",
		]);
		expect(d.outcome).toBe("candidate");
	});

	it("a later approval clears human changes requested", () => {
		const reviews = [
			{ login: "bob", state: "CHANGES_REQUESTED", commitId: "a" },
			{ login: "bob", state: "APPROVED", commitId: "b" },
			{ login: "coderabbitai[bot]", state: "CHANGES_REQUESTED", commitId: "b" },
		];
		expect(run(snap({ reviews })).outcome).toBe("candidate");
	});

	it("root files count as one top-level dir", () => {
		const files = [file("a.md", 1), file("b.md", 1), file("src/a.ts", 1)];
		expect(run(snap({ files })).outcome).toBe("candidate");
		files.push(file("test/a.ts", 1));
		expect(rulesOf(run(snap({ files })))).toEqual(["max_dirs"]);
	});

	it("CODEOWNERS globs follow GitHub semantics", async () => {
		const c = await load("teams: { protected: sec }");
		const owned = (codeowners: Context["codeowners"], path: string) =>
			run(snap({ files: [file(path)] }), c, ["ci"], ctx({ codeowners }))
				.outcome === "escalate";
		const sec = (pattern: string) => ({ pattern, owners: ["@org/sec"] });
		const dev = (pattern: string) => ({ pattern, owners: ["@org/dev"] });

		expect(owned([sec("/src/core/"), dev("/src/*")], "src/core/x.ts")).toBe(
			true,
		);
		expect(owned([sec("docs/*")], "docs/a.md")).toBe(true);
		expect(owned([sec("docs/*")], "docs/x/a.md")).toBe(false);
		expect(owned([sec("docs/")], "docs/x/a.md")).toBe(true);
		expect(owned([sec("docs/**")], "docs/x/a.md")).toBe(true);
		expect(owned([sec("*.sql")], "a/b/c.sql")).toBe(true);
		expect(owned([sec("/*.sql")], "a/b.sql")).toBe(false);
		expect(owned([sec("/*.sql")], "b.sql")).toBe(true);
		expect(owned([sec("src/core")], "src/core/x.ts")).toBe(true);
	});

	it("external breaking titles always escalate", () => {
		for (const title of ["fix!: x", "fix(api)!: x", "feat!: x"]) {
			const d = run(snap({ authorClass: "external", title }));
			expect(rulesOf(d)).toEqual(["author_class"]);
		}
		expect(run(snap({ title: "fix!: x" })).outcome).toBe("candidate");
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
	const yaml =
		"paths: { protected: ['src/auth/**'] }\nteams: { protected: sec }";
	const x = ctx({
		codeowners: [{ pattern: "/src/core/", owners: ["@org/sec"] }],
	});
	const required = ["ci", "lint"];
	const everything = snap({
		draft: true,
		mergeable: false,
		author: "dependabot[bot]",
		baseRef: "release/1",
		headRef: "release-plz-1",
		authorClass: "bot",
		title: "feat!: x",
		body: "Stacked on #1",
		bodyTruncated: true,
		diffTruncated: true,
		codeRabbit: "CHANGES_REQUESTED",
		checks: [
			{ name: "ci", conclusion: "failure" },
			{ name: "lint", conclusion: "in_progress", startedAt: ago(61) },
		],
		files: [
			".castellan.yml",
			"CODEOWNERS",
			".github/a.yml",
			"src/auth/t.ts",
			"src/core/x.ts",
			"migrations/1.sql",
		].map((p) => file(p, 1)),
		reviews: [{ login: "bob", state: "CHANGES_REQUESTED", commitId: "a" }],
	});
	const files = (...paths: string[]) => ({
		files: paths.map((p) => file(p, 1)),
	});
	const green = [
		{ name: "ci", conclusion: "success" },
		{ name: "lint", conclusion: "success" },
	];

	it("skip beats escalate", async () => {
		const c = await load(yaml);
		expect(rulesOf(run(everything, c, required, x))).toEqual(["draft"]);
	});

	it("walks every rule in order, one hit at a time", async () => {
		const off = await load(`mode: off\n${yaml}`);
		const on = await load(yaml);
		const steps: [string, Partial<Snapshot>, Config?][] = [
			["draft", { draft: false }],
			["skipped_author", { author: "alice" }],
			["non_default_base", { baseRef: "main" }],
			["skip_branch", { headRef: "fix/x" }],
			["mode_off", {}, on],
			["merge_conflict", { mergeable: true }],
			[
				"required_check_stale",
				{
					checks: [
						{ name: "ci", conclusion: "failure" },
						{ name: "lint", conclusion: "pending", startedAt: null },
					],
				},
			],
			[
				"ci_unsettled",
				{
					checks: [
						{ name: "ci", conclusion: "failure" },
						{ name: "lint", conclusion: "success" },
					],
				},
			],
			[
				"castellan_config",
				files(
					"CODEOWNERS",
					".github/a.yml",
					"src/auth/t.ts",
					"src/core/x.ts",
					"migrations/1.sql",
				),
			],
			[
				"codeowners_file",
				files(
					".github/a.yml",
					"src/auth/t.ts",
					"src/core/x.ts",
					"migrations/1.sql",
				),
			],
			[
				"github_dir",
				files("src/auth/t.ts", "src/core/x.ts", "migrations/1.sql"),
			],
			["protected_path", files("src/core/x.ts", "migrations/1.sql")],
			["protected_owner", { files: [file("migrations/1.sql", 200)] }],
			[
				"required_check",
				{
					checks: [...green, { name: "docs", conclusion: "failure" }],
				},
			],
			["check_failing", { checks: green }],
			["coderabbit", { codeRabbit: null }],
			[
				"max_lines",
				files(..."123456".split("").map((n) => `migrations/${n}.sql`)),
			],
			["max_files", files("migrations/1.sql", "a/x.ts", "b/y.ts")],
			["max_dirs", files("migrations/1.sql")],
			["diff_truncated", { diffTruncated: false }],
			["migration", files("pnpm-lock.yaml")],
			["generated_only", files("src/a.ts")],
			["human_changes_requested", { reviews: [] }],
			["body_truncated", { bodyTruncated: false }],
			["stacked", { body: "" }],
			["author_class", { authorClass: "maintainer" }],
		];
		expect(steps.map(([rule]) => rule)).toEqual(RULE_IDS);
		let s = everything;
		let c = off;
		for (const [rule, fix, next] of steps) {
			expect(rulesOf(run(s, c, required, x))[0]).toBe(rule);
			s = { ...s, ...fix };
			c = next ?? c;
		}
		expect(run(s, c, required, x).outcome).toBe("candidate");
	});

	it("mode off comes after the other skip rules and before escalation", async () => {
		const c = await load("mode: off");
		const s = snap({ files: [file(".castellan.yml")] });
		expect(rulesOf(run(s, c))).toEqual(["mode_off"]);
		expect(rulesOf(run({ ...s, draft: true }, c))).toEqual(["draft"]);
	});
});
