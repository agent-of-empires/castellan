import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { loadConfig } from "../src/config.js";
import type { GithubTransport } from "../src/github.js";
import type { MessagesClient } from "../src/llm.js";
import { triage } from "../src/triage.js";

const repo = { owner: "org", repo: "r" };
const issue = { number: 7, title: "Crash on start", body: "boom" };

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
		return {
			content: [
				{
					type: "text",
					text: typeof out === "string" ? out : JSON.stringify(out),
				},
			],
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
			field("fp", "Priority", ["P0", "P1", "P2"]),
			field("fz", "Size", ["XS", "S", "M", "L", "XL"]),
			field("fr", "Roadmap", ["📋 Planned", "💡 Future / Exploring"]),
		],
	},
};

function world(
	opts: {
		labels?: string[];
		items?: { id: string; project: { id: string }; fieldValues: unknown }[];
		project?: typeof project | null;
	} = {},
) {
	const state = {
		repository: {
			labels: {
				nodes: ["area:core", "area:web", "bug", "P1"].map((name) => ({ name })),
			},
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
	const graphql = vi.fn(async (q: string, _v?: unknown) =>
		q.includes("addProjectV2ItemById")
			? { addProjectV2ItemById: { item: { id: "NEW" } } }
			: q.includes("updateProjectV2ItemFieldValue")
				? {}
				: state,
	);
	const request = vi.fn(async (_r: string, _p?: unknown) => ({ data: {} }));
	return {
		graphql,
		request,
		transport: { graphql, request } as unknown as GithubTransport,
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
		.filter(([route]) => route.endsWith("/comments"))
		.map(([, p]) => (p as { body: string }).body)
		.join("\n");

describe("triage", () => {
	it("does nothing when off", async () => {
		const w = world();
		const m = llm(answer);
		const r = await triage(issue, await cfg("mode: off"), w.transport, repo, {
			client: m.client,
		});
		expect(r).toEqual({ ok: true, mode: "off" });
		expect(w.graphql).not.toHaveBeenCalled();
		expect(m.create).not.toHaveBeenCalled();
	});

	it("shadow only comments the proposal", async () => {
		const w = world();
		const r = await triage(issue, await cfg(""), w.transport, repo, {
			client: llm(answer).client,
		});
		expect(r).toMatchObject({
			ok: true,
			mode: "shadow",
			proposal: {
				labels: ["P1", "area:core", "bug"],
				fields: [
					{ field: "Priority", option: "P1" },
					{ field: "Size", option: "M" },
					{ field: "Status", option: "Ready" },
				],
			},
		});
		expect(routes(w.request)).toEqual([
			"POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
		]);
		const body = commentBody(w.request);
		expect(body).toContain("Proposed:");
		expect(body).toContain("`ready-for-agent`");
		expect(body).not.toContain("Fit");
	});

	it("enforce applies labels, fields, removes needs-triage and keeps ready-for-agent comment only", async () => {
		const w = world();
		await triage(issue, await cfg("mode: enforce"), w.transport, repo, {
			client: llm(answer).client,
		});
		expect(routes(w.request)).toEqual([
			"POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
			"DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}",
			"POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
		]);
		expect(w.request.mock.calls[0]?.[1]).toMatchObject({
			labels: ["P1", "area:core", "bug"],
		});
		expect(sets(w.graphql)).toEqual([
			{ project: "PRJ", item: "NEW", field: "fp", option: "fp:P1" },
			{ project: "PRJ", item: "NEW", field: "fz", option: "fz:M" },
			{ project: "PRJ", item: "NEW", field: "fs", option: "fs:Ready" },
		]);
		const body = commentBody(w.request);
		expect(body).toContain("Applied:");
		expect(body).not.toContain("Fit:");
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
							{ name: "M", field: { name: "Size" } },
							{ name: "Ready", field: { name: "Status" } },
							{ name: "P0", field: { name: "Priority" } },
						],
					},
				},
			],
		});
		const r = await triage(
			issue,
			await cfg("mode: enforce"),
			w.transport,
			repo,
			{
				client: llm(answer).client,
			},
		);
		expect(r).toMatchObject({ proposal: { labels: [], fields: [] } });
		expect(routes(w.request)).toEqual([
			"DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}",
			"POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
		]);
		expect(sets(w.graphql)).toEqual([]);
	});

	it("derives Status from the existing priority and sets Roadmap for features only", async () => {
		const feature = { ...answer, type: "feature", priority: "P0" };
		const w = world({ labels: ["P2"] });
		const r = await triage(
			issue,
			await cfg("mode: enforce"),
			w.transport,
			repo,
			{
				client: llm(feature).client,
			},
		);
		expect(r).toMatchObject({
			proposal: {
				labels: ["area:core", "enhancement"],
				fields: [
					{ field: "Priority", option: "P2" },
					{ field: "Size", option: "M" },
					{ field: "Status", option: "Backlog" },
					{ field: "Roadmap", option: "💡 Future / Exploring" },
				],
			},
		});
		const bug = world({ labels: [] });
		const rb = await triage(
			issue,
			await cfg("mode: enforce"),
			bug.transport,
			repo,
			{
				client: llm(answer).client,
			},
		);
		expect(JSON.stringify(rb)).not.toContain("Roadmap");
	});

	it("resolves ids by configured names and reports unknown options", async () => {
		const w = world({
			project: {
				...project,
				fields: { nodes: [field("fp", "Prio", ["P1"])] },
			},
		});
		const config = await cfg("mode: enforce\nproject: { priorityField: Prio }");
		await triage(issue, config, w.transport, repo, {
			client: llm(answer).client,
		});
		expect(sets(w.graphql)).toEqual([
			{ project: "PRJ", item: "NEW", field: "fp", option: "fp:P1" },
		]);
		const body = commentBody(w.request);
		expect(body).toContain("Size: M (not found on the project)");
	});

	it.each([
		["prose", "nope"],
		["unknown area", { ...answer, area: "area:nope" }],
		["bad priority", { ...answer, priority: "P9" }],
	])("fails closed on %s and writes nothing", async (_n, out) => {
		const w = world();
		const r = await triage(
			issue,
			await cfg("mode: enforce"),
			w.transport,
			repo,
			{
				client: llm(out).client,
			},
		);
		expect(r).toMatchObject({ ok: false, error: "invalid_output" });
		expect(w.request).not.toHaveBeenCalled();
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
		expect(w.request).not.toHaveBeenCalled();
	});

	it("puts the issue text behind a boundary and uses the triage model", async () => {
		const m = llm(answer);
		await triage(issue, await cfg(""), world().transport, repo, {
			client: m.client,
		});
		const p = m.create.mock.calls[0]?.[0] as {
			model: string;
			system: string;
			messages: { content: string }[];
		};
		expect(p.model).toBe("us.anthropic.claude-haiku-5-5");
		expect(p.system).toContain("area:core, area:web");
		expect(p.messages[0]?.content).toMatch(/BEGIN title [0-9a-f]{32}\nCrash/);
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
