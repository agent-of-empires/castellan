import { CONFIG_PATH, type Config } from "./config.js";
import type { Snapshot } from "./snapshot.js";

export interface Reason {
	rule: string;
	text: string;
	path?: string;
}

export interface Decision {
	outcome: "skip" | "escalate" | "candidate";
	reasons: Reason[];
}

export interface CodeownersRule {
	pattern: string;
	/** As written in CODEOWNERS, e.g. `@org/team`. */
	owners: string[];
}

/** Facts the caller resolves from GitHub so that `evaluate` stays pure. */
export interface Context {
	defaultBranch: string;
	codeowners: CodeownersRule[];
	/** Linked issue numbers that carry the configured bug label. */
	bugIssues: number[];
}

type Hit = { text: string; path?: string };
type Rule = (s: Snapshot, c: Config, required: string[], x: Context) => Hit[];

const SKIPPED_AUTHORS = ["dependabot[bot]"];
const PASSING = ["success", "neutral"];
const OK = [...PASSING, "skipped"];
const GENERATED =
	/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock)$|\.generated\.|(^|\/)(dist|generated)\//;
const MIGRATION = /(^|\/)migrations?\//;

const when = (cond: boolean, text: string): Hit[] => (cond ? [{ text }] : []);
const paths = (files: string[], text: string): Hit[] =>
	files.map((path) => ({ text, path }));

function glob(p: string) {
	return p
		.split(/(\*\*\/|\*\*|\*|\?)/)
		.map((t) =>
			t === "**/"
				? "(?:.*/)?"
				: t === "**"
					? ".*"
					: t === "*"
						? "[^/]*"
						: t === "?"
							? "[^/]"
							: t.replace(/[.+^${}()|[\]\\]/g, "\\$&"),
		)
		.join("");
}

/** Gitignore-like: a pattern without a slash matches at any depth, a match covers everything below it. */
function matchesPath(pattern: string, path: string) {
	const p = pattern.replace(/\/$/, "");
	const anchored = p.startsWith("/") || p.includes("/");
	const body = glob(p.replace(/^\//, ""));
	return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${body}(?:/.*)?$`).test(
		path,
	);
}

const touching = (s: Snapshot, patterns: string[]) =>
	s.files
		.map((f) => f.path)
		.filter((p) => patterns.some((pat) => matchesPath(pat, p)));

const lines = (s: Snapshot) =>
	s.files.reduce((n, f) => n + f.additions + f.deletions, 0);

const isBot = (login: string) => login.endsWith("[bot]");

function humanChangesRequested(s: Snapshot) {
	const latest = new Map<string, string>();
	for (const r of s.reviews) {
		if (r.state !== "COMMENTED" && !isBot(r.login))
			latest.set(r.login, r.state);
	}
	return [...latest].filter(([, state]) => state === "CHANGES_REQUESTED");
}

const SKIP: Record<string, Rule> = {
	draft: (s) => when(s.draft, "PR is a draft"),
	skipped_author: (s) =>
		when(
			SKIPPED_AUTHORS.includes(s.author),
			`${s.author} PRs are not evaluated`,
		),
	non_default_base: (s, _c, _r, x) =>
		when(
			s.baseRef !== x.defaultBranch,
			`base ${s.baseRef} is not the default branch ${x.defaultBranch}`,
		),
	skip_branch: (s, c) =>
		when(
			c.skip_branches.some((g) => new RegExp(`^${glob(g)}$`).test(s.headRef)),
			`head branch ${s.headRef} matches skip_branches`,
		),
	mode_off: (_s, c) => when(c.mode === "off", "mode is off"),
};

const ESCALATE: Record<string, Rule> = {
	castellan_config: (s) =>
		paths(touching(s, [CONFIG_PATH]), `touches ${CONFIG_PATH}`),
	github_dir: (s) => paths(touching(s, [".github/"]), "touches .github/"),
	protected_path: (s, c) =>
		paths(
			touching(s, [...c.paths.protected, ...c.paths.release]),
			"touches a protected or release path",
		),
	protected_owner: (s, c, _r, x) => {
		const team = c.teams.protected;
		if (!team) return [];
		const owned = s.files
			.map((f) => f.path)
			.filter((p) => {
				const rule = x.codeowners.findLast((r) => matchesPath(r.pattern, p));
				return rule?.owners.some((o) => o.endsWith(`/${team}`));
			});
		return paths(owned, `owned by the protected team ${team}`);
	},
	check_failing: (s) =>
		s.checks
			.filter((k) => !OK.includes(k.conclusion))
			.map((k) => ({ text: `check ${k.name} is ${k.conclusion}` })),
	required_check: (s, _c, required) =>
		required
			.filter(
				(name) =>
					!s.checks.some(
						(k) => k.name === name && PASSING.includes(k.conclusion),
					),
			)
			.map((name) => ({
				text: `required check ${name} is missing or skipped`,
			})),
	coderabbit: (s) =>
		when(s.codeRabbit === "CHANGES_REQUESTED", "CodeRabbit requested changes"),
	max_lines: (s, c) =>
		when(
			lines(s) > c.limits.maxLines,
			`${lines(s)} changed lines, limit ${c.limits.maxLines}`,
		),
	max_files: (s, c) =>
		when(
			s.filesTruncated || s.files.length > c.limits.maxFiles,
			`more than ${c.limits.maxFiles} files changed`,
		),
	max_dirs: (s, c) => {
		const dirs = new Set(
			s.files
				.filter((f) => f.path.includes("/"))
				.map((f) => f.path.split("/")[0]),
		);
		return when(
			dirs.size > c.limits.maxTopLevelDirs,
			`${dirs.size} top-level dirs changed, limit ${c.limits.maxTopLevelDirs}`,
		);
	},
	migration: (s) =>
		paths(
			s.files.map((f) => f.path).filter((p) => MIGRATION.test(p)),
			"touches a migration",
		),
	generated_only: (s) =>
		when(
			s.files.length > 0 && s.files.every((f) => GENERATED.test(f.path)),
			"only generated files changed",
		),
	human_changes_requested: (s) =>
		humanChangesRequested(s).map(([login]) => ({
			text: `${login} requested changes`,
		})),
	stacked: (s) =>
		when(/\bstacked on #\d+/i.test(s.body), "PR is stacked on another PR"),
	author_class: (s, c, _r, x) => {
		if (s.authorClass === "bot") return [{ text: "bot authors never merge" }];
		if (s.authorClass !== "external") return [];
		if (/^feat(\(.*\))?!?:/i.test(s.title)) {
			return [{ text: "external feat: always goes to a human" }];
		}
		if (!/^fix(\(.*\))?!?:/i.test(s.title)) {
			return [{ text: "external PRs must have a fix: title" }];
		}
		return when(
			!s.linkedIssues.some((n) => x.bugIssues.includes(n)),
			`external fix: needs Closes #n where n is labeled ${c.labels.bug}`,
		);
	},
};

/** Deny by default; first rule that hits decides. `candidate` still needs the model. */
export function evaluate(
	snapshot: Snapshot,
	config: Config,
	requiredChecks: string[],
	ctx: Context,
): Decision {
	for (const [outcome, rules] of [
		["skip", SKIP],
		["escalate", ESCALATE],
	] as const) {
		for (const [rule, check] of Object.entries(rules)) {
			const hits = check(snapshot, config, requiredChecks, ctx);
			if (hits.length)
				return { outcome, reasons: hits.map((h) => ({ rule, ...h })) };
		}
	}
	return { outcome: "candidate", reasons: [] };
}
