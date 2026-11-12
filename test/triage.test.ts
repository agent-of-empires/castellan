import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { loadConfig } from "../src/config.js";
import type { GithubTransport } from "../src/github.js";
import type { MessagesClient } from "../src/llm.js";
import { escapeText, triage } from "../src/triage.js";

const repo = { owner: "org", repo: "r" };
const issue = { number: 7, title: "Crash on start", body: "boom" };
const LABELS = "POST /repos/{owner}/{repo}/issues/{issue_number}/labels";
const COMMENT = "POST /repos/{owner}/{repo}/issues/{issue_number}/comments";
const REMOVE =
	"DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}";

async function cfg(yaml: string) {
	const r = await loadConfig("main", async () => yaml);
	if (!r.ok) throw new Error(r.error);
	return r.config;
}

const answer = {
	priority: "P1",
	area: "area:core",
	type: "bug",
	size: "M",
	readyForAgent: { suggest: true, reason: "small and clear" },
	reasons: { priority: "p", area: "a", type: "t", size: "s" },
};

function llm(out: unknown | Error) {
	const create = vi.fn(async (_p: unknown, _o?: unknown) => {
		if (out instanceof Error) throw out;
		const text = typeof out === "string" ? out : JSON.stringify(out);
		return {
			content: [{ type: "text", text }],
			usage: { input_tokens: 1, output_tokens: 1 },
		};
	});
	return {
		create,
		client: { messages: { create } } as unknown as MessagesClient,
	};
}

const field = (id: string, name: string, options: string[]) => ({
	id,
	name,
	options: options.map((o) => ({ id: `${id}:${o}`, name: o })),
});

const project = {
	id: "PRJ",
	title: "Agent of Empires",
	fields: {
		nodes: [
			field("fs", "Status", ["Ready", "Backlog"]),
			field("fp", "Priority", ["P0", "P1", "P2", "P3"]),
			field("fz", "Size", ["XS", "S", "M", "L", "XL"]),
			field("fr", "Roadmap state", ["📋 Planned", "💡 Future / Exploring"]),
		],
	},
};

const REPO_LABELS = [
	"P0",
	"P1",
	"P2",
	"P3",
	"area:core",
	"area:web",
	"bug",
	"enhancement",
];

function world(
	opts: {
		labels?: string[];
		items?: { id: string; project: { id: string }; fieldValues: unknown }[];
		project?: typeof project | null;
		repoLabels?: string[];
		pageSize?: number;
		failSet?: boolean;
		comments?: { body: string; login: string }[];
		failComments?: boolean;
		/** Awaited by every comment listing, to hold concurrent runs together. */
		onList?: () => Promise<void>;
	} = {},
) {
	const log: string[] = [];
	const state = {
		repository: {
			issue: {
				id: "ISSUE",
				labels: {
					nodes: (opts.labels ?? ["needs-triage"]).map((name) => ({ name })),
				},
				projectItems: { nodes: opts.items ?? [] },
			},
		},
		organization: {
			projectsV2: {
				nodes: opts.project === null ? [] : [opts.project ?? project],
			},
		},
	};
	const all = opts.repoLabels ?? REPO_LABELS;
	const size = opts.pageSize ?? 100;
	const graphql = vi.fn(async (q: string, v?: unknown) => {
		if (q.includes("addProjectV2ItemById")) {
			log.push("add-item");
			return { addProjectV2ItemById: { item: { id: "NEW" } } };
		}
		if (q.includes("updateProjectV2ItemFieldValue")) {
			if (opts.failSet) throw new Error("boom");
			log.push("set-field");
			return {};
		}
		if (q.includes("pageInfo")) {
			const start = Number((v as { after: string | null }).after ?? 0);
			const end = start + size;
			return {
				repository: {
					labels: {
						nodes: all.slice(start, end).map((name) => ({ name })),
						pageInfo: {
							hasNextPage: end < all.length,
							endCursor: String(end),
						},
					},
				},
			};
		}
		return state;
	});
	const store = (opts.comments ?? []).map(({ body, login }, i) => ({
		id: i + 1,
		body,
		user: { login },
	}));
	let nextId = store.length + 1;
	const request = vi.fn(async (route: string, p?: unknown) => {
		log.push(route);
		const q = p as { body?: string; comment_id?: number };
		if (route === COMMENT) {
			store.push({
				id: nextId++,
				body: q.body ?? "",
				user: { login: "castellan[bot]" },
			});
		} else if (route.startsWith("PATCH ")) {
			const m = store.find((c) => c.id === q.comment_id);
			if (m) m.body = q.body ?? "";
		} else if (
			route.startsWith("DELETE /repos/{owner}/{repo}/issues/comments")
		) {
			const i = store.findIndex((c) => c.id === q.comment_id);
			if (i < 0) throw Object.assign(new Error("nf"), { status: 404 });
			store.splice(i, 1);
		}
		return { data: {} };
	});
	const paginate = vi.fn(async (route: string) => {
		if (route === "GET /repos/{owner}/{repo}/issues/{issue_number}/comments") {
			if (opts.failComments) throw new Error("comments unavailable");
			await opts.onList?.();
			return store.map((c) => ({ ...c }));
		}
		return [];
	});
	return {
		graphql,
		paginate,
		request,
		log,
		store,
		transport: { graphql, paginate, request } as unknown as GithubTransport,
	};
}

const sets = (g: ReturnType<typeof world>["graphql"]) =>
	g.mock.calls
		.filter(([q]) => q.includes("updateProjectV2ItemFieldValue"))
		.map(([, v]) => v as { field: string; option: string; item: string });

const routes = (r: ReturnType<typeof world>["request"]) =>
	r.mock.calls.map(([route]) => route);

const commentBody = (r: ReturnType<typeof world>["request"]) =>
	r.mock.calls
		.filter(([route]) => route === COMMENT || route.startsWith("PATCH "))
		.map(([, p]) => (p as { body: string }).body)
		.join("\n");

function nothingWritten(w: ReturnType<typeof world>) {
	expect(w.request).not.toHaveBeenCalled();
	expect(sets(w.graphql)).toEqual([]);
	expect(w.log).toEqual([]);
}

const run = async (
	w: ReturnType<typeof world>,
	yaml: string,
	out: unknown = answer,
) => {
	const m = llm(out);
	const r = await triage(
		issue,
		await cfg(yaml),
		w.transport,
		repo,
		{ client: m.client },
		{ login: "castellan[bot]" },
	);
	return { r, m };
};

describe("triage", () => {
	it("does nothing when off", async () => {
		const w = world();
		const { r, m } = await run(w, "mode: off");
		expect(r).toEqual({ ok: true, skipped: "off" });
		expect(w.graphql).not.toHaveBeenCalled();
		expect(m.create).not.toHaveBeenCalled();
	});

	it("triage.enabled false skips even when mode is enforce", async () => {
		const w = world();
		const { r, m } = await run(w, "mode: enforce\ntriage: { enabled: false }");
		expect(r).toEqual({ ok: true, skipped: "off" });
		expect(w.graphql).not.toHaveBeenCalled();
		expect(m.create).not.toHaveBeenCalled();
	});

	it("mode off skips regardless of triage.enabled", async () => {
		const w = world();
		const { r } = await run(w, "mode: off\ntriage: { enabled: true }");
		expect(r).toEqual({ ok: true, skipped: "off" });
		expect(w.graphql).not.toHaveBeenCalled();
	});

	it("applies labels and fields by default even with mode shadow", async () => {
		const w = world();
		const { r } = await run(w, "mode: shadow");
		expect(r).toEqual({
			ok: true,
			proposal: expect.objectContaining({
				labels: ["P1", "area:core", "bug"],
				fields: [
					{ field: "Priority", option: "P1" },
					{ field: "Size", option: "M" },
					{ field: "Status", option: "Ready" },
				],
			}),
		});
		expect(routes(w.request)).toEqual([LABELS, COMMENT, REMOVE]);
		const body = commentBody(w.request);
		expect(body).toContain("Applied:");
		expect(body).toContain("`ready-for-agent`");
		expect(body).toContain("Fit is not set by triage");
	});

	it("enforce writes labels and fields, comments, and removes needs-triage last", async () => {
		const w = world();
		await run(w, "mode: enforce");
		expect(w.log).toEqual([
			LABELS,
			"add-item",
			"set-field",
			"set-field",
			"set-field",
			COMMENT,
			REMOVE,
		]);
		expect(w.request.mock.calls[0]?.[1]).toMatchObject({
			labels: ["P1", "area:core", "bug"],
		});
		expect(sets(w.graphql)).toEqual([
			{ project: "PRJ", item: "NEW", field: "fp", option: "fp:P1" },
			{ project: "PRJ", item: "NEW", field: "fz", option: "fz:M" },
			{ project: "PRJ", item: "NEW", field: "fs", option: "fs:Ready" },
		]);
		expect(commentBody(w.request)).toContain("Applied:");
		expect(routes(w.request)).not.toContain("ready-for-agent");
	});

	it("dryRun returns the proposal and writes nothing", async () => {
		const w = world();
		const m = llm(answer);
		const r = await triage(
			issue,
			await cfg("mode: enforce"),
			w.transport,
			repo,
			{ client: m.client },
			{ dryRun: true },
		);
		expect(r).toMatchObject({
			ok: true,
			proposal: { labels: ["P1", "area:core", "bug"] },
		});
		expect(w.request).not.toHaveBeenCalled();
		expect(sets(w.graphql)).toEqual([]);
		expect(w.log).toEqual([]);
	});

	it("keeps needs-triage when a write fails", async () => {
		const w = world({ failSet: true });
		await expect(run(w, "mode: enforce")).rejects.toThrow("boom");
		expect(routes(w.request)).not.toContain(REMOVE);
	});

	it("never overwrites existing labels or project fields", async () => {
		const w = world({
			labels: ["needs-triage", "P0", "area:web", "bug"],
			items: [
				{
					id: "IT",
					project: { id: "PRJ" },
					fieldValues: {
						nodes: [
							{ name: "Ready", field: { name: "Status" } },
							{ name: "P0", field: { name: "Priority" } },
						],
					},
				},
			],
		});
		const { r } = await run(w, "mode: enforce");
		expect(r).toMatchObject({
			proposal: { labels: [], fields: [{ field: "Size", option: "M" }] },
		});
		expect(routes(w.request)).toEqual([COMMENT, REMOVE]);
		expect(sets(w.graphql)).toEqual([
			{ project: "PRJ", item: "IT", field: "fz", option: "fz:M" },
		]);
	});

	it("derives Status from the existing priority and sets Roadmap for features only", async () => {
		const feature = { ...answer, type: "feature", priority: "P0" };
		const { r } = await run(
			world({ labels: ["needs-triage", "P2"] }),
			"mode: enforce",
			feature,
		);
		expect(r).toMatchObject({
			proposal: {
				labels: ["area:core", "enhancement"],
				fields: [
					{ field: "Priority", option: "P2" },
					{ field: "Size", option: "M" },
					{ field: "Status", option: "Backlog" },
					{ field: "Roadmap state", option: "💡 Future / Exploring" },
				],
			},
		});
		const bug = await run(world(), "mode: enforce");
		expect(JSON.stringify(bug.r)).not.toContain("Roadmap");
	});

	it("maps the default P3 to Backlog", async () => {
		const { r } = await run(world(), "", { ...answer, priority: "P3" });
		expect(r).toMatchObject({
			proposal: {
				labels: ["P3", "area:core", "bug"],
				fields: [
					{ field: "Priority", option: "P3" },
					{ field: "Size", option: "M" },
					{ field: "Status", option: "Backlog" },
				],
			},
		});
	});

	it("takes priorities, status and roadmap names from config", async () => {
		const w = world({
			repoLabels: ["urgent", "later", "area:core", "bug", "enhancement"],
			project: {
				...project,
				fields: {
					nodes: [
						field("fs", "Status", ["Now", "Next"]),
						field("fp", "Priority", ["urgent", "later"]),
						field("fz", "Size", ["M"]),
						field("fr", "Roadmap state", ["Soon"]),
					],
				},
			},
		});
		const { r, m } = await run(
			w,
			`triage:
  priority_labels: [urgent, later]
  status_by_priority: { urgent: Now, later: Next }
  roadmap_by_status: { Now: Soon, Next: Soon }`,
			{ ...answer, priority: "urgent", type: "feature" },
		);
		expect(r).toMatchObject({
			proposal: {
				fields: [
					{ field: "Priority", option: "urgent" },
					{ field: "Size", option: "M" },
					{ field: "Status", option: "Now" },
					{ field: "Roadmap state", option: "Soon" },
				],
			},
		});
		const p = m.create.mock.calls[0]?.[0] as { system: string };
		expect(p.system).toContain("urgent, later");
	});

	it("is a no-op without needs-triage or when nothing is missing", async () => {
		const done = {
			id: "IT",
			project: { id: "PRJ" },
			fieldValues: {
				nodes: ["Status", "Priority", "Size"].map((n) => ({
					name: "x",
					field: { name: n },
				})),
			},
		};
		const absent = world({ labels: ["P1", "area:core", "bug"] });
		const a = await run(absent, "mode: enforce");
		expect(a.r).toEqual({ ok: true, skipped: "no needs-triage label" });
		expect(a.m.create).not.toHaveBeenCalled();
		nothingWritten(absent);

		const full = ["needs-triage", "P1", "area:core", "bug"];
		const enforce = world({ labels: full, items: [done] });
		const e = await run(enforce, "mode: enforce");
		expect(e.r).toEqual({ ok: true, skipped: "nothing missing" });
		expect(e.m.create).not.toHaveBeenCalled();
		expect(routes(enforce.request)).toEqual([REMOVE]);
	});

	it("fails closed when the project is not found, writing nothing", async () => {
		const w = world({ project: null });
		const { r, m } = await run(w, "mode: enforce");
		expect(r).toEqual({
			ok: false,
			error: "unresolved",
			detail: "project not found: Agent of Empires",
		});
		expect(m.create).not.toHaveBeenCalled();
		nothingWritten(w);
	});

	it("skips a project option that does not exist and comments it, writing the rest", async () => {
		const w = world({
			project: {
				...project,
				fields: {
					nodes: [
						field("fs", "Status", ["Ready", "Backlog"]),
						field("fp", "Priority", ["P0", "P1", "P2"]),
						field("fz", "Size", ["XS", "S", "M", "L", "XL"]),
					],
				},
			},
		});
		const { r } = await run(w, "mode: enforce", { ...answer, priority: "P3" });
		expect(r).toMatchObject({
			ok: true,
			proposal: {
				labels: ["P3", "area:core", "bug"],
				fields: [
					{ field: "Size", option: "M" },
					{ field: "Status", option: "Backlog" },
				],
			},
		});
		expect(w.request.mock.calls[0]?.[1]).toMatchObject({
			labels: ["P3", "area:core", "bug"],
		});
		expect(sets(w.graphql).map((s) => s.field)).toEqual(["fz", "fs"]);
		expect(commentBody(w.request)).toContain(
			'Not set: Priority (no option "P3" in the project)',
		);
		expect(routes(w.request)).toEqual([LABELS, COMMENT, REMOVE]);
	});

	it("skips a project field that does not exist and comments it", async () => {
		const w = world();
		const { r } = await run(w, "mode: enforce\nproject: { sizeField: Effort }");
		expect(r).toMatchObject({ ok: true });
		expect(sets(w.graphql).map((s) => s.field)).toEqual(["fp", "fs"]);
		expect(routes(w.request)).toEqual([LABELS, COMMENT, REMOVE]);
		expect(commentBody(w.request)).toContain(
			"Not set: Effort (no such field in the project)",
		);
	});

	it.each([
		["prose", "nope"],
		["unknown area", { ...answer, area: "area:nope" }],
		["unconfigured priority", { ...answer, priority: "P9" }],
		["priority missing in the repo", { ...answer, priority: "P3" }],
		["bad size", { ...answer, size: "HUGE" }],
	])("fails closed on %s and writes nothing", async (name, out) => {
		const w = world({
			repoLabels:
				name === "priority missing in the repo"
					? REPO_LABELS.filter((l) => l !== "P3")
					: REPO_LABELS,
		});
		const { r } = await run(w, "mode: enforce", out);
		expect(r).toMatchObject({ ok: false, error: "invalid_output" });
		nothingWritten(w);
	});

	it("ignores extra keys in reasons and readyForAgent", async () => {
		const w = world();
		const { r } = await run(w, "", {
			...answer,
			readyForAgent: { ...answer.readyForAgent, extra: "x" },
			reasons: { ...answer.reasons, readyForAgent: "copied" },
		});
		expect(r).toMatchObject({ ok: true });
		expect(commentBody(w.request)).not.toContain("copied");
	});

	it("rejects a type whose label is missing in the repo", async () => {
		const w = world({ repoLabels: REPO_LABELS.filter((l) => l !== "bug") });
		const { r } = await run(w, "mode: enforce");
		expect(r).toMatchObject({ ok: false, error: "invalid_output" });
		nothingWritten(w);
	});

	it("reads every page of repo labels", async () => {
		const w = world({ pageSize: 2 });
		const { r, m } = await run(w, "");
		expect(r).toMatchObject({ ok: true });
		const p = m.create.mock.calls[0]?.[0] as { system: string };
		expect(p.system).toContain("area:core, area:web");
		const pages = w.graphql.mock.calls.filter(([q]) => q.includes("pageInfo"));
		expect(pages).toHaveLength(4);
	});

	it("fails closed on sdk errors and a missing key", async () => {
		const w = world();
		const c = await cfg("llm: { provider: anthropic }");
		expect(
			await triage(issue, c, w.transport, repo, {
				client: llm(new Error("boom")).client,
			}),
		).toMatchObject({ ok: false, error: "sdk_error" });
		expect(await triage(issue, c, w.transport, repo)).toMatchObject({
			ok: false,
			error: "missing_key",
		});
		nothingWritten(w);
	});

	it("goes through the shared client path: boundary, caps and budget", async () => {
		const m = llm(answer);
		await triage(
			{ ...issue, body: "x".repeat(4000) },
			await cfg(""),
			world().transport,
			repo,
			{ client: m.client },
		);
		const p = m.create.mock.calls[0]?.[0] as {
			model: string;
			messages: { content: string }[];
		};
		expect(p.model).toBe("us.anthropic.claude-haiku-5-5");
		const user = p.messages[0]?.content ?? "";
		expect(user).toMatch(/BEGIN title [0-9a-f]{32}\nCrash/);
		expect(user).toContain("These fields were truncated: body.");

		const w = world();
		const budget = await triage(issue, await cfg(""), w.transport, repo, {
			client: llm(answer).client,
			maxCostUsd: 0,
		});
		expect(budget).toMatchObject({ ok: false, error: "budget" });
		nothingWritten(w);
	});

	it("escapes mentions and links from model text in the comment", async () => {
		const w = world();
		await run(w, "", {
			...answer,
			readyForAgent: {
				suggest: true,
				reason:
					"ping @bob [click](https://evil.example/x) or https://evil.example",
			},
			reasons: { ...answer.reasons, size: "see @org/team\nnow" },
		});
		const body = commentBody(w.request);
		expect(body).not.toMatch(/@\w/);
		expect(body).not.toContain("http");
		expect(body).toContain("ping bob click or");
	});

	it("labels the existing project priority, not the model's guess", async () => {
		const w = world({
			labels: ["needs-triage", "area:core", "bug"],
			items: [
				{
					id: "IT",
					project: { id: "PRJ" },
					fieldValues: {
						nodes: [{ name: "P0", field: { name: "Priority" } }],
					},
				},
			],
		});
		const { r } = await run(w, "mode: enforce");
		// area:core and bug are already labels, so only the priority label is proposed
		expect(r).toMatchObject({
			proposal: {
				labels: ["P0"],
				fields: [
					{ field: "Size", option: "M" },
					{ field: "Status", option: "Ready" },
				],
			},
		});
		expect(w.request.mock.calls[0]?.[1]).toMatchObject({ labels: ["P0"] });
	});

	it.each([
		["unconfigured", "Urgent", [...REPO_LABELS, "Urgent"]],
		["missing repository label", "P0", REPO_LABELS.filter((l) => l !== "P0")],
	])(
		"rejects %s project priority before writes",
		async (_name, priority, repoLabels) => {
			const w = world({
				repoLabels,
				items: [
					{
						id: "IT",
						project: { id: "PRJ" },
						fieldValues: {
							nodes: [
								{ name: priority, field: { name: "Priority" } },
								{ name: "Ready", field: { name: "Status" } },
							],
						},
					},
				],
			});
			const { r } = await run(w, "mode: enforce");
			expect(r).toMatchObject({ ok: false, error: "unresolved" });
			nothingWritten(w);
		},
	);

	it("does not repeat an outcome when model reasons change", async () => {
		const first = world();
		await run(first, "");
		const second = world({
			comments: [{ body: commentBody(first.request), login: "castellan[bot]" }],
		});
		await run(second, "", {
			...answer,
			readyForAgent: { suggest: true, reason: "different reason" },
			reasons: {
				priority: "different",
				area: "different",
				type: "different",
				size: "different",
			},
		});
		expect(routes(second.request)).not.toContain(COMMENT);
	});

	it("does not trust another author's matching marker", async () => {
		const first = world();
		await run(first, "");
		const second = world({
			comments: [{ body: commentBody(first.request), login: "someone-else" }],
		});
		await run(second, "");
		expect(routes(second.request)).toContain(COMMENT);
	});

	it("edits the existing comment when the outcome changed, count stays one", async () => {
		const first = world();
		await run(first, "", { ...answer, priority: "P3" });
		const second = world({
			comments: [{ body: commentBody(first.request), login: "castellan[bot]" }],
		});
		await run(second, "");
		expect(routes(second.request)).not.toContain(COMMENT);
		expect(routes(second.request)).toContain(
			"PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}",
		);
		expect(second.store).toHaveLength(1);
		expect(second.store[0]?.body).toContain("<!-- castellan triage ");
		expect(second.store[0]?.body).not.toBe(first.store[0]?.body);
	});

	it("an identical outcome writes no comment", async () => {
		const first = world();
		await run(first, "");
		const second = world({
			comments: [{ body: commentBody(first.request), login: "castellan[bot]" }],
		});
		await run(second, "");
		expect(
			routes(second.request).filter((r) => r.includes("/comments")),
		).toEqual([]);
	});

	it("two concurrent runs leave exactly one triage comment", async () => {
		let listed = 0;
		let release: () => void = () => {};
		const both = new Promise<void>((r) => {
			release = r;
		});
		// Hold the first listing of each run until both runs have issued it.
		const gate = async () => {
			if (listed++ < 2) {
				if (listed === 2) release();
				await both;
			}
		};
		const w = world({ onList: gate });
		await Promise.all([run(w, ""), run(w, "")]);
		const mine = w.store.filter(
			(c) =>
				c.user.login === "castellan[bot]" &&
				c.body.includes("<!-- castellan triage "),
		);
		expect(mine).toHaveLength(1);
		expect(routes(w.request).filter((r) => r === COMMENT)).toHaveLength(2);
	});

	it("makes no writes when comment lookup fails", async () => {
		const w = world({ failComments: true });
		await expect(run(w, "mode: enforce")).rejects.toThrow(
			"comments unavailable",
		);
		nothingWritten(w);
	});
});

describe("escapeText", () => {
	it("strips mentions, links and urls", () => {
		expect(escapeText("hi @a, [t](http://x.y) http://z.w ok")).toBe(
			"hi a, t ok",
		);
		expect(escapeText("mail a@b.com")).toBe("mail a@b.com");
	});
});

describe("templates/needs-triage.yml", () => {
	it("labels on open in 10 lines or fewer", () => {
		const text = readFileSync("templates/needs-triage.yml", "utf8");
		expect(text.trimEnd().split("\n").length).toBeLessThanOrEqual(10);
		const wf = parse(text);
		expect(wf.on.issues.types).toEqual(["opened"]);
		expect(text).toContain("--add-label needs-triage");
	});
});
