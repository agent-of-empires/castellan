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
const PENDING = ["pending", "queued", "in_progress"];
const OK = [...PASSING, "skipped"];
const GENERATED =
	/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock)$|\.generated\.|(^|\/)(dist|generated)\//;
const CODEOWNERS_FILE = /^(\.github\/|docs\/)?CODEOWNERS$/;

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

/** GitHub CODEOWNERS semantics: no slash means any depth, `dir/` and `dir/**` recurse, `dir/*` does not. */
function matchesPath(pattern: string, path: string) {
	const dir = pattern.endsWith("/");
	const p = pattern.replace(/^\//, "");
	const anchored =
		pattern.startsWith("/") || p.replace(/\/$/, "").includes("/");
	const last = p.slice(p.lastIndexOf("/") + 1);
	const below = dir || /[*?]/.test(last) ? "" : "(?:/.*)?";
	const body = glob(dir ? `${p}**` : p);
	return new RegExp(`^${anchored ? "" : "(?:.*/)?"}${body}${below}$`).test(
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

const slug = (team: string) => team.replace(/^.*\//, "");

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

const castellanConfig: Rule = (s) =>
	paths(touching(s, [CONFIG_PATH]), `touches ${CONFIG_PATH}`);

const codeownersFile: Rule = (s) =>
	paths(
		s.files.map((f) => f.path).filter((p) => CODEOWNERS_FILE.test(p)),
		"touches CODEOWNERS",
	);

const githubDir: Rule = (s) =>
	paths(touching(s, [".github/"]), "touches .github/");

const protectedPath: Rule = (s, c) =>
	paths(
		touching(s, [...c.paths.protected, ...c.paths.release]),
		"touches a protected or release path",
	);

const protectedOwner: Rule = (s, c, _r, x) => {
	const team = c.teams.protected && slug(c.teams.protected);
	if (!team) return [];
	const owned = s.files
		.map((f) => f.path)
		.filter((p) => {
			const rule = x.codeowners.findLast((r) => matchesPath(r.pattern, p));
			return rule?.owners.some(
				(o) => o.startsWith("@") && o.includes("/") && slug(o) === team,
			);
		});
	return paths(owned, `owned by the protected team ${team}`);
};

const ESCALATE: Record<string, Rule> = {
	castellan_config: castellanConfig,
	codeowners_file: codeownersFile,
	github_dir: githubDir,
	protected_path: protectedPath,
	protected_owner: protectedOwner,
	check_failing: (s) =>
		s.checks
			.filter((k) => ![...OK, ...PENDING].includes(k.conclusion))
			.map((k) => ({ text: `check ${k.name} is ${k.conclusion}` })),
	check_pending: (s) =>
		s.checks
			.filter((k) => PENDING.includes(k.conclusion))
			.map((k) => ({ text: `check ${k.name} is ${k.conclusion}` })),
	required_check: (s, _c, required) =>
		required
			.filter(
				(name) =>
					!s.checks.some((k) => k.name === name && OK.includes(k.conclusion)),
			)
			.map((name) => ({
				text: `required check ${name} is missing or did not pass`,
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
			s.files.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : "")),
		);
		return when(
			dirs.size > c.limits.maxTopLevelDirs,
			`${dirs.size} top-level dirs changed, limit ${c.limits.maxTopLevelDirs}`,
		);
	},
	diff_truncated: (s) => when(s.diffTruncated, "diff was truncated"),
	migration: (s, c) =>
		paths(touching(s, c.paths.migrations), "touches a migration"),
	generated_only: (s) =>
		when(
			s.files.length > 0 && s.files.every((f) => GENERATED.test(f.path)),
			"only generated files changed",
		),
	human_changes_requested: (s) =>
		humanChangesRequested(s).map(([login]) => ({
			text: `${login} requested changes`,
		})),
	body_truncated: (s) =>
		when(s.bodyTruncated, "PR body was truncated, stacked check unreliable"),
	stacked: (s) =>
		when(/\bstacked on #\d+/i.test(s.body), "PR is stacked on another PR"),
	author_class: (s, c, _r, x) => {
		if (s.authorClass === "bot") return [{ text: "bot authors never merge" }];
		if (s.authorClass !== "external") return [];
		if (/^\w+(\(.*\))?!:/.test(s.title)) {
			return [{ text: "external breaking change always goes to a human" }];
		}
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

/** True when a change touches a protected path, a protected team's files, or castellan's own governance files. `act` re-checks this before approving. */
export const touchesProtected = (s: Snapshot, c: Config, x: Context) =>
	[
		castellanConfig,
		codeownersFile,
		githubDir,
		protectedPath,
		protectedOwner,
	].some((rule) => rule(s, c, [], x).length > 0);

export const RULE_IDS = [...Object.keys(SKIP), ...Object.keys(ESCALATE)];

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
