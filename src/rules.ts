import { CONFIG_PATH, type Config } from "./config.js";
import { FIX_TRAILER } from "./fix.js";
import type { Snapshot } from "./snapshot.js";

export { FIX_TRAILER };

export interface Reason {
	rule: string;
	text: string;
	path?: string;
	/** New-file line the reason is about, when it is anchored to the diff. */
	line?: number;
}

export interface Decision {
	outcome: "skip" | "wait" | "escalate" | "candidate";
	reasons: Reason[];
}

export interface CodeownersRule {
	pattern: string;
	/** As written in CODEOWNERS, e.g. `@org/team`. */
	owners: string[];
}

/** Facts the caller resolves from GitHub so that `evaluate` stays pure. */
export interface Context {
	/** Epoch ms; the clock for stale check runs. */
	now: number;
	defaultBranch: string;
	codeowners: CodeownersRule[];
	/** Linked issue numbers that carry the configured bug label. */
	bugIssues: number[];
	/** Path of the shared central config when this repo hosts it. */
	centralPath?: string;
	/** Castellan's own login, so a commit it wrote can be recognised. */
	login?: string;
}

type Hit = { text: string; path?: string };
type Rule = (s: Snapshot, c: Config, required: string[], x: Context) => Hit[];

const SKIPPED_AUTHORS = ["dependabot[bot]"];
const PASSING = ["success", "neutral"];
const PENDING = ["pending", "queued", "in_progress"];
const MINUTE = 60_000;
const OK = [...PASSING, "skipped"];
/** Lockfiles, generated trees and `.generated.` files: never worth model context. */
export const GENERATED =
	/(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock)$|\.generated\.|(^|\/)(dist|generated)\//;
const CODEOWNERS_FILE = /^(\.github\/|docs\/)?CODEOWNERS$/;

type Check = Snapshot["checks"][number];

/** Pending past the limit. A run with no `started_at` never counts: the API has no creation time. */
const isStale = (k: Check, now: number, limitMinutes: number) =>
	PENDING.includes(k.conclusion) &&
	k.startedAt != null &&
	now - k.startedAt > limitMinutes * MINUTE;

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
export function matchesPath(pattern: string, path: string) {
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
	filesOf(s).filter((p) => patterns.some((pat) => matchesPath(pat, p)));

const filesOf = (s: Snapshot) => s.files.map((f) => f.path);

const isCodeownersFile = (p: string) => CODEOWNERS_FILE.test(p);

const isProtectedPattern = (p: string, c: Config) =>
	[...c.paths.protected, ...c.paths.release].some((pat) => matchesPath(pat, p));

/** A file the protected team owns, by the last CODEOWNERS rule that matches it. */
const isProtectedTeamFile = (p: string, c: Config, x: Context) => {
	const team = c.teams.protected ? slug(c.teams.protected) : "";
	if (!team) return false;
	const rule = x.codeowners.findLast((r) => matchesPath(r.pattern, p));
	return (
		rule?.owners.some(
			(o) => o.startsWith("@") && o.includes("/") && slug(o) === team,
		) === true
	);
};

/**
 * A path a fix must not write: castellan's own governance files, a protected or
 * release path, or a protected team's file. `act` refuses a merge that touches
 * one, and a suggestion on one is posted without its button.
 */
export const writeBarred = (path: string, c: Config, x: Context) =>
	matchesPath(CONFIG_PATH, path) ||
	(x.centralPath ? matchesPath(`/${x.centralPath}`, path) : false) ||
	isCodeownersFile(path) ||
	matchesPath(".github/", path) ||
	isProtectedPattern(path, c) ||
	isProtectedTeamFile(path, c, x);

const lines = (s: Snapshot) =>
	s.files.reduce((n, f) => n + f.additions + f.deletions, 0);

const isBot = (login: string) => login.endsWith("[bot]");

/**
 * A commit on this PR that castellan wrote: its login as author or committer, or
 * the trailer, which survives an unmapped email. Checked on every commit, not
 * just the head, so a later author commit does not launder it.
 */
/** Whether any listed commit is castellan's, by login or fix trailer. */
export function wroteCommits(
	commits: Snapshot["commits"],
	truncated: boolean,
	login?: string,
): boolean {
	// A cut commit list drops the newest commits, which are the ones castellan
	// wrote, so an incomplete list is treated as if it wrote one.
	return (
		truncated ||
		commits.some(
			(c) =>
				FIX_TRAILER.test(c.message) || (!!login && c.logins.includes(login)),
		)
	);
}

export function castellanWrote(s: Snapshot, login?: string): boolean {
	return wroteCommits(s.commits, s.commitsTruncated, login);
}

/**
 * A human approval on the current head, which is what lets castellan's own code
 * merge. A bot approval is not one: an App or Action can approve without a person,
 * so counting it would let the writer judge its own commit. Nor is an approval
 * from someone who cannot write to the repo, or from the PR author, who can open
 * a second account and approve their own model-written commit.
 */
export function humanApprovedHead(s: Snapshot, login?: string): boolean {
	return s.reviews.some(
		(r) =>
			r.state === "APPROVED" &&
			r.commitId === s.headSha &&
			r.login !== login &&
			r.login !== s.author &&
			// `author_association` only says member or collaborator, which includes
			// read and triage, so the permission itself is what counts.
			r.canWrite &&
			!isBot(r.login),
	);
}

function humanChangesRequested(s: Snapshot) {
	const latest = new Map<string, string>();
	for (const r of s.reviews) {
		if (r.state !== "COMMENTED" && !isBot(r.login))
			latest.set(r.login, r.state);
	}
	return [...latest].filter(([, state]) => state === "CHANGES_REQUESTED");
}

/** A team slug: `@org/team` or `team` to `team`. */
export const slug = (team: string) => team.replace(/^.*\//, "");

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

const castellanConfig: Rule = (s, _c, _r, x) => [
	...paths(touching(s, [CONFIG_PATH]), `touches ${CONFIG_PATH}`),
	...(x.centralPath
		? paths(touching(s, [`/${x.centralPath}`]), "touches the central config")
		: []),
];

const codeownersFile: Rule = (s) =>
	paths(filesOf(s).filter(isCodeownersFile), "touches CODEOWNERS");

const githubDir: Rule = (s) =>
	paths(
		filesOf(s).filter((p) => matchesPath(".github/", p)),
		"touches .github/",
	);

const protectedPath: Rule = (s, c) =>
	paths(
		filesOf(s).filter((p) => isProtectedPattern(p, c)),
		"touches a protected or release path",
	);

const protectedOwner: Rule = (s, c, _r, x) => {
	const team = c.teams.protected ? slug(c.teams.protected) : "";
	if (!team) return [];
	return paths(
		filesOf(s).filter((p) => isProtectedTeamFile(p, c, x)),
		`owned by the protected team ${team}`,
	);
};

/** Escalates before `wait`: without a merge ref, pull_request workflows never start. */
const CONFLICT: Record<string, Rule> = {
	merge_conflict: (s) => when(s.mergeable === false, "PR has merge conflicts"),
};

/** Before `wait`, so a stuck required check escalates instead of waiting forever. A newer same-name run decides instead. */
const STALE_REQUIRED: Record<string, Rule> = {
	required_check_stale: (s, c, required, x) =>
		s.checks
			.filter(
				(k) =>
					required.includes(k.name) &&
					isStale(k, x.now, c.limits.staleCheckMinutes) &&
					!s.checks.some(
						(o) =>
							o.name === k.name && k.id != null && o.id != null && o.id > k.id,
					),
			)
			.map((k) => ({
				text: `required check ${k.name} is stale (${k.conclusion} for more than ${c.limits.staleCheckMinutes} min)`,
			})),
};

/** CI is unsettled: a required check has no run yet, or a run is still going. Stale runs do not count. */
const WAIT: Record<string, Rule> = {
	ci_unsettled: (s, c, required, x) => [
		...required
			.filter((name) => !s.checks.some((k) => k.name === name))
			.map((name) => ({ text: `required check ${name} has not started` })),
		...s.checks
			.filter(
				(k) =>
					PENDING.includes(k.conclusion) &&
					!isStale(k, x.now, c.limits.staleCheckMinutes),
			)
			.map((k) => ({ text: `check ${k.name} is ${k.conclusion}` })),
	],
};

const ESCALATE: Record<string, Rule> = {
	castellan_config: castellanConfig,
	codeowners_file: codeownersFile,
	github_dir: githubDir,
	protected_path: protectedPath,
	protected_owner: protectedOwner,
	required_check: (s, _c, required) =>
		required
			.filter(
				(name) =>
					!s.checks.some((k) => k.name === name && OK.includes(k.conclusion)),
			)
			.map((name) => ({
				text: `required check ${name} did not pass`,
			})),
	check_failing: (s, c, _r, x) =>
		s.checks
			.filter(
				(k) =>
					!OK.includes(k.conclusion) &&
					!isStale(k, x.now, c.limits.staleCheckMinutes),
			)
			.map((k) => ({ text: `check ${k.name} is ${k.conclusion}` })),
	coderabbit: (s) =>
		when(s.codeRabbit === "CHANGES_REQUESTED", "CodeRabbit requested changes"),
	// The numbers are `size: fixed`, which is the default, so a repo that already
	// set them keeps the gate it had. `model` drops the numbers for a judgement,
	// `off` drops both.
	max_lines: (s, c) =>
		c.size === "fixed"
			? when(
					lines(s) > c.limits.maxLines,
					`${lines(s)} changed lines, limit ${c.limits.maxLines}`,
				)
			: [],
	max_files: (s, c) => {
		if (s.filesTruncated)
			return [{ text: "more files changed than the snapshot holds" }];
		return c.size === "fixed"
			? when(
					s.files.length > c.limits.maxFiles,
					`more than ${c.limits.maxFiles} files changed`,
				)
			: [];
	},
	max_dirs: (s, c) => {
		if (c.size !== "fixed") return [];
		const dirs = new Set(
			s.files.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : "")),
		);
		return when(
			dirs.size > c.limits.maxTopLevelDirs,
			`${dirs.size} top-level dirs changed, limit ${c.limits.maxTopLevelDirs}`,
		);
	},
	// Not a policy limit: the diff is cut by `CAPS` in `llm.ts`, so the review
	// would be of part of the change. Every mode escalates rather than merge.
	diff_truncated: (s) => when(s.diffTruncated, "diff was truncated"),
	migration: (s, c) =>
		paths(touching(s, c.paths.migrations), "touches a migration"),
	generated_only: (s) =>
		when(
			s.files.length > 0 && s.files.every((f) => GENERATED.test(f.path)),
			"only generated files changed",
		),
	// The writer is not the judge: code castellan committed never merges on its
	// own verdict, whatever the model says about it.
	castellan_written: (s, _c, _r, x) =>
		when(
			castellanWrote(s, x.login) && !humanApprovedHead(s, x.login),
			"castellan wrote a commit on this head and no human approved it",
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

const STAGES = [
	["skip", SKIP],
	["escalate", CONFLICT],
	["escalate", STALE_REQUIRED],
	["wait", WAIT],
	["escalate", ESCALATE],
] as const;

export const RULE_IDS = STAGES.flatMap(([, rules]) => Object.keys(rules));

/** Escalations that only say the change is large; a review of it is still useful. */
export const SIZE_RULES = new Set([
	"max_lines",
	"max_files",
	"max_dirs",
	"diff_truncated",
]);

/**
 * True when every escalate rule outside the size set is clean. `evaluate` returns
 * at the first rule with a hit, so its reasons would hide a later rule such as
 * `author_class` or `human_changes_requested` behind an oversized change.
 */
export function onlySizeEscalates(
	snapshot: Snapshot,
	config: Config,
	requiredChecks: string[],
	ctx: Context,
): boolean {
	return !Object.entries(ESCALATE).some(
		([rule, check]) =>
			!SIZE_RULES.has(rule) &&
			check(snapshot, config, requiredChecks, ctx).length > 0,
	);
}

/** Deny by default; first rule that hits decides. `wait` means CI is unsettled, so nothing is judged yet. `candidate` still needs the model. */
export function evaluate(
	snapshot: Snapshot,
	config: Config,
	requiredChecks: string[],
	ctx: Context,
): Decision {
	for (const [outcome, rules] of STAGES) {
		for (const [rule, check] of Object.entries(rules)) {
			const hits = check(snapshot, config, requiredChecks, ctx);
			if (hits.length)
				return { outcome, reasons: hits.map((h) => ({ rule, ...h })) };
		}
	}
	return { outcome: "candidate", reasons: [] };
}
