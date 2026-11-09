import { describe, expect, it } from "vitest";
import { dryRun, failed, runForIssue, runForPr, sweep } from "../src/run.js";
import { APPROVE, COMMENT, fake, llm, merge } from "./fake.js";

const repo = { owner: "o", repo: "r" };
const author = { login: "castellan[bot]" };

describe("runForPr", () => {
	it("fails closed on an invalid config without writing", async () => {
		const f = fake({ config: "mode: nope" });
		const r = await runForPr({ transport: f.transport, repo, author }, 3);
		expect(r.status).toBe("config_error");
		expect(failed({ kind: "pr", number: 3, result: r })).toBe(true);
		expect(f.routes()).not.toContain(COMMENT);
	});

	it("skips a draft without calling the model or writing", async () => {
		const f = fake({ draft: true });
		const m = llm(merge);
		const r = await runForPr(
			{ transport: f.transport, repo, author, llm: m.deps },
			3,
		);
		expect(r).toMatchObject({ status: "skipped" });
		expect(m.create).not.toHaveBeenCalled();
		expect(f.routes()).not.toContain(COMMENT);
	});

	it("escalates on rules alone and never calls the model", async () => {
		const f = fake({
			files: [{ filename: ".github/x.yml", additions: 1, deletions: 0 }],
		});
		const m = llm(merge);
		const r = await runForPr(
			{ transport: f.transport, repo, author, llm: m.deps },
			3,
		);
		expect(r).toMatchObject({
			status: "done",
			brief: { outcome: { verdict: "escalate" }, source: "skipped" },
		});
		expect(m.create).not.toHaveBeenCalled();
		expect(f.routes()).toContain(COMMENT);
	});

	it("shadow posts a merge brief but never approves", async () => {
		const f = fake();
		const r = await runForPr(
			{ transport: f.transport, repo, author, llm: llm(merge).deps },
			3,
		);
		expect(r).toMatchObject({
			status: "done",
			brief: { outcome: { verdict: "merge" }, source: "llm" },
			act: { approved: false, queued: false },
		});
		expect(f.routes()).not.toContain(APPROVE);
	});

	it("enforce approves, and the mode override wins over the config", async () => {
		const f = fake({ config: "mode: shadow" });
		const r = await runForPr(
			{
				transport: f.transport,
				repo,
				author,
				llm: llm(merge).deps,
				mode: "enforce",
			},
			3,
		);
		expect(f.routes()).toContain(APPROVE);
		expect(r).toMatchObject({ act: { approved: true, queued: true } });
	});

	it("reuses the cached review for the same head", async () => {
		const f = fake();
		const m = llm(merge);
		const deps = { transport: f.transport, repo, author, llm: m.deps };
		await runForPr(deps, 3);
		const again = await runForPr(deps, 3);
		expect(m.create).toHaveBeenCalledTimes(1);
		expect(again).toMatchObject({ brief: { source: "cache" } });
	});
});

describe("dryRun", () => {
	it("prints the brief and makes no write, even in enforce", async () => {
		const f = fake();
		const printed: string[] = [];
		const deps = dryRun(
			{
				transport: f.transport,
				repo,
				author,
				llm: llm(merge).deps,
				mode: "enforce",
			},
			(b) => printed.push(b),
		);
		const r = await runForPr(deps, 3);
		expect(r).toMatchObject({ status: "done", act: { approved: false } });
		expect(printed.join("")).toContain("Castellan brief");
		const writes = f.routes().filter((x) => !x.startsWith("GET "));
		expect(writes).toEqual([]);
		expect(f.graphql).not.toHaveBeenCalled();
	});
});

describe("runForIssue and sweep", () => {
	it("triages from the default branch config; off skips", async () => {
		const f = fake({ config: "mode: off" });
		const r = await runForIssue({ transport: f.transport, repo, author }, 4);
		expect(r).toEqual({
			status: "triaged",
			triage: { ok: true, skipped: "off" },
		});
	});

	it("sweeps open non-draft PRs and labeled issues, not PRs listed as issues", async () => {
		const f = fake({ config: "mode: off" });
		const items = await sweep({ transport: f.transport, repo, author });
		expect(items.map((i) => `${i.kind}${i.number}`)).toEqual(["pr1", "issue9"]);
	});
});
