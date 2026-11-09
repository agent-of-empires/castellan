import { describe, expect, it, vi } from "vitest";
import { inputsFromEnv } from "../src/adapters/action.js";
import { parseConfigSource } from "../src/adapters/auth.js";
import { parseCli } from "../src/adapters/cli.js";
import {
	centralWarnings,
	loadCentral,
	parseLocator,
	signS3Get,
} from "../src/central.js";
import { loadConfig, mergeDocs } from "../src/config.js";
import { evaluatePull } from "../src/pipeline.js";
import { fake, llm, merge } from "./fake.js";

const repo = { owner: "o", repo: "r" };

describe("mergeDocs", () => {
	it("upper wins for scalars and recurses into objects", () => {
		expect(
			mergeDocs(
				{ mode: "shadow", limits: { maxLines: 10, maxFiles: 2 } },
				{ mode: "enforce", limits: { maxLines: 20 } },
			),
		).toEqual({ mode: "enforce", limits: { maxLines: 20, maxFiles: 2 } });
	});

	it("appends arrays lower then upper with exact dedupe", () => {
		const out = mergeDocs(
			{ prompt: { guidance: ["a", "b"] }, trustedAuthors: ["x"] },
			{ prompt: { guidance: ["b", "c", "A"] }, trustedAuthors: ["y", "x"] },
		);
		expect(out).toEqual({
			prompt: { guidance: ["a", "b", "c", "A"] },
			trustedAuthors: ["x", "y"],
		});
	});

	it("appends triage.priority_labels", () => {
		expect(
			mergeDocs(
				{ triage: { priority_labels: ["P0", "P1"] } },
				{ triage: { priority_labels: ["P1", "P2"] } },
			),
		).toEqual({ triage: { priority_labels: ["P0", "P1", "P2"] } });
	});

	it("key! replaces and never survives", () => {
		const out = mergeDocs(
			{ prompt: { guidance: ["a"] }, skip_branches: ["x"] },
			{ prompt: { "guidance!": ["b"] }, "skip_branches!": ["y"] },
		);
		expect(out).toEqual({ prompt: { guidance: ["b"] }, skip_branches: ["y"] });
	});

	it("drops the marker even when the lower layer lacks the key", () => {
		expect(
			mergeDocs({}, { "guidance!": ["b"], prompt: { "guidance!": ["c"] } }),
		).toEqual({ guidance: ["b"], prompt: { guidance: ["c"] } });
	});

	it("rejects a key set both ways in one document", () => {
		expect(() => mergeDocs({}, { a: [1], "a!": [2] })).toThrow(/both a and a!/);
	});
});

describe("loadConfig with a lower layer", () => {
	const reader = (text: string | null) => async () => text;

	it("validates once after merging and keeps built-in defaults for absent keys", async () => {
		const r = await loadConfig(
			"main",
			reader("mode: enforce\nprompt:\n  guidance: [b]"),
			{ prompt: { guidance: ["a"] }, skip_branches: ["central-*"] },
		);
		expect(r).toMatchObject({
			ok: true,
			config: {
				mode: "enforce",
				prompt: { guidance: ["a", "b"] },
				skip_branches: ["central-*"],
			},
		});
	});

	it("skip_branches! replaces the central list", async () => {
		const r = await loadConfig("main", reader("skip_branches!: [mine-*]"), {
			skip_branches: ["central-*"],
		});
		expect(r).toMatchObject({
			ok: true,
			config: { skip_branches: ["mine-*"] },
		});
	});

	it("a missing repo file leaves the central layer", async () => {
		const r = await loadConfig("main", reader(null), { mode: "enforce" });
		expect(r).toMatchObject({ ok: true, config: { mode: "enforce" } });
	});

	it("fails closed on a non-mapping repo file", async () => {
		const r = await loadConfig("main", reader("- a"), {});
		expect(r).toMatchObject({ ok: false });
	});

	it("rejects `!` keys with no layer below", async () => {
		const r = await loadConfig("main", reader("skip_branches!: [a]"));
		expect(r).toMatchObject({ ok: false });
	});
});

describe("parseLocator", () => {
	it("defaults to <owner>/.github castellan.yml", () => {
		expect(parseLocator(undefined, "acme")).toEqual({
			kind: "git",
			owner: "acme",
			repo: ".github",
			path: "castellan.yml",
		});
	});

	it("reads owner/repo with and without a path", () => {
		expect(parseLocator("a/b", "x")).toMatchObject({
			repo: "b",
			path: "castellan.yml",
		});
		expect(parseLocator("a/b:cfg/c.yml", "x")).toMatchObject({
			path: "cfg/c.yml",
		});
	});

	it("reads s3 locators and rejects malformed ones", () => {
		expect(parseLocator("s3://bkt/dir/c.yml", "x")).toEqual({
			kind: "s3",
			bucket: "bkt",
			key: "dir/c.yml",
		});
		expect(() => parseLocator("s3://bkt", "x")).toThrow(/s3:\/\/bucket\/key/);
		expect(() => parseLocator("nonsense", "x")).toThrow(/owner\/repo/);
	});
});

describe("signS3Get", () => {
	it("matches the AWS SigV4 documentation example", () => {
		const h = signS3Get(
			new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
			"us-east-1",
			{
				accessKeyId: "AKIAIOSFODNN7EXAMPLE",
				secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
			},
			new Date("2013-05-24T00:00:00Z"),
			{ range: "bytes=0-9" },
		);
		expect(h.authorization).toBe(
			"AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
		);
	});
});

describe("loadCentral", () => {
	const s3 = { kind: "s3", bucket: "b", key: "k.yml" } as const;
	const env = {
		AWS_ACCESS_KEY_ID: "a",
		AWS_SECRET_ACCESS_KEY: "s",
		AWS_REGION: "eu-west-1",
	};
	const transport = fake().transport;

	it("reads S3 with a signed request", async () => {
		const fetchImpl = vi.fn(async () => new Response("mode: enforce"));
		const r = await loadCentral({ transport, fetch: fetchImpl }, s3, env);
		expect(r).toEqual({ ok: true, doc: { mode: "enforce" } });
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [
			URL,
			RequestInit,
		];
		expect(String(url)).toBe("https://s3.eu-west-1.amazonaws.com/b/k.yml");
		expect((init.headers as Record<string, string>).authorization).toMatch(
			/^AWS4-HMAC-SHA256 /,
		);
	});

	it("S3 denied, missing, or without credentials is an error", async () => {
		const denied = vi.fn(async () => new Response("", { status: 403 }));
		expect(
			await loadCentral({ transport, fetch: denied }, s3, env),
		).toMatchObject({
			ok: false,
			error: expect.stringContaining("403"),
		});
		const missing = vi.fn(async () => new Response("", { status: 404 }));
		expect(
			await loadCentral({ transport, fetch: missing }, s3, env),
		).toMatchObject({
			ok: false,
			error: expect.stringContaining("not found"),
		});
		expect(await loadCentral({ transport }, s3, {})).toMatchObject({
			ok: false,
			error: expect.stringContaining("AWS credentials"),
		});
	});

	it("rejects `!` keys in the central document", async () => {
		const fetchImpl = vi.fn(async () => new Response("skip_branches!: [a]"));
		expect(
			await loadCentral({ transport, fetch: fetchImpl }, s3, env),
		).toMatchObject({
			ok: false,
			error: expect.stringContaining("none below"),
		});
	});

	it("reads once per cache", async () => {
		const fetchImpl = vi.fn(async () => new Response("mode: off"));
		const cache = new Map();
		await loadCentral({ transport, fetch: fetchImpl, cache }, s3, env);
		await loadCentral({ transport, fetch: fetchImpl, cache }, s3, env);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});
});

describe("centralWarnings", () => {
	it("warns when the default central repo is outside the allowlist", () => {
		expect(centralWarnings(["o/r"], undefined)).toEqual([
			expect.stringContaining("o/.github"),
		]);
	});

	it("is quiet when the repo is allowed or the locator is S3", () => {
		expect(centralWarnings(["o/*"], undefined)).toEqual([]);
		expect(centralWarnings(["o/r", "a/b"], "a/b")).toEqual([]);
		expect(centralWarnings(["o/r"], "s3://b/k")).toEqual([]);
	});
});

describe("adapters", () => {
	it("the CLI accepts --config-source and rejects a bad value", () => {
		expect(
			parseCli(["o/r", "1", "--config-source", "central"]).configSource,
		).toBe("central");
		expect(() => parseCli(["o/r", "1", "--config-source", "nope"])).toThrow(
			/--config-source must be one of repo, central, db/,
		);
	});

	it("the Action reads the input, then the env var, and rejects a bad value", () => {
		expect(inputsFromEnv({ INPUT_CONFIG_SOURCE: "db" }).configSource).toBe(
			"db",
		);
		expect(
			inputsFromEnv({ CASTELLAN_CONFIG_SOURCE: "central" }).configSource,
		).toBe("central");
		expect(inputsFromEnv({}).configSource).toBeUndefined();
		expect(() => inputsFromEnv({ INPUT_CONFIG_SOURCE: "x" })).toThrow(
			/config-source input/,
		);
	});

	it("parseConfigSource passes undefined through", () => {
		expect(parseConfigSource(undefined, "x")).toBeUndefined();
	});
});

/** One PR in `o/r` touching `touched`; contents are served per `owner/repo:path`. */
function world(contents: Record<string, string>, touched = "src/a.ts") {
	const w = fake();
	const request = vi.fn(async (route: string, p: Record<string, unknown>) => {
		if (route === "GET /repos/{owner}/{repo}/contents/{path}") {
			const text = contents[`${p.owner}/${p.repo}:${p.path}`];
			if (text === undefined)
				throw Object.assign(new Error("nf"), { status: 404 });
			return { data: text };
		}
		return w.request(route, p);
	});
	const paginate = vi.fn(async (route: string, p: unknown) =>
		route.endsWith("/files")
			? [{ filename: touched, additions: 1, deletions: 0 }]
			: w.transport.paginate(route as never, p as never),
	);
	const m = llm(merge);
	const transport = { ...w.transport, request, paginate } as never;
	return {
		w,
		request,
		env: { transport, login: "castellan[bot]", llm: m.deps },
	};
}

const reasons = (r: Awaited<ReturnType<typeof evaluatePull>>) =>
	r.brief?.outcome.reasons.map((x) => `${x.rule}: ${x.text}`) ?? [];

describe("pipeline with config-source central", () => {
	it("repo mode never reads the central file", async () => {
		const { w, request, env } = world({
			"o/.github:castellan.yml": "mode: nonsense",
		});
		void w;
		const r = await evaluatePull(env, repo, 3, { dryRun: true });
		expect(r.status).toBe("dry_run");
		expect(
			request.mock.calls.some(
				([, p]) => (p as { repo?: string }).repo === ".github",
			),
		).toBe(false);
	});

	it("reads <owner>/.github:castellan.yml and layers the repo file on top", async () => {
		const { env } = world({
			"o/.github:castellan.yml":
				"mode: enforce\nprompt:\n  guidance: [central]",
			"o/r:.castellan.yml": "prompt:\n  guidance: [repo]",
		});
		const r = await evaluatePull({ ...env, configSource: "central" }, repo, 3, {
			dryRun: true,
		});
		expect(r.brief?.shadow).toBe(false);
		const create = (
			env.llm.client as unknown as {
				messages: { create: { mock: { calls: unknown[][] } } };
			}
		).messages.create;
		const body = JSON.stringify(create.mock.calls[0]);
		expect(body.indexOf("central")).toBeGreaterThan(-1);
		expect(body.indexOf("central")).toBeLessThan(body.indexOf("repo\\"));
	});

	it("honors an owner/repo:path locator", async () => {
		const { env } = world({ "acme/policy:cfg/c.yml": "mode: enforce" });
		const r = await evaluatePull(
			{
				...env,
				configSource: "central",
				centralLocator: "acme/policy:cfg/c.yml",
			},
			repo,
			3,
			{ dryRun: true },
		);
		expect(r.brief?.shadow).toBe(false);
	});

	it("reads an s3 locator", async () => {
		vi.stubEnv("AWS_ACCESS_KEY_ID", "a");
		vi.stubEnv("AWS_SECRET_ACCESS_KEY", "s");
		vi.stubEnv("AWS_REGION", "us-east-1");
		const { env } = world({});
		const fetchImpl = vi.fn(async () => new Response("mode: enforce"));
		const r = await evaluatePull(
			{
				...env,
				configSource: "central",
				centralLocator: "s3://b/k.yml",
				fetch: fetchImpl,
			},
			repo,
			3,
			{ dryRun: true },
		);
		vi.unstubAllEnvs();
		expect(r.brief?.shadow).toBe(false);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("a missing central file escalates with the error as the reason", async () => {
		const { env } = world({});
		const r = await evaluatePull({ ...env, configSource: "central" }, repo, 3, {
			dryRun: true,
		});
		expect(r.brief?.outcome.verdict).toBe("escalate");
		expect(reasons(r)).toEqual([
			expect.stringMatching(
				/^config_invalid: .*o\/\.github:castellan\.yml not found/,
			),
		]);
	});

	it("invalid central YAML escalates", async () => {
		const { env } = world({ "o/.github:castellan.yml": "mode: [" });
		const r = await evaluatePull({ ...env, configSource: "central" }, repo, 3, {
			dryRun: true,
		});
		expect(reasons(r)[0]).toMatch(
			/^config_invalid: cannot read central config/,
		);
	});

	it("an invalid merged result escalates", async () => {
		const { env } = world({
			"o/.github:castellan.yml": "mode: shadow",
			"o/r:.castellan.yml": "mode: nonsense",
		});
		const r = await evaluatePull({ ...env, configSource: "central" }, repo, 3, {
			dryRun: true,
		});
		expect(reasons(r)[0]).toMatch(/^config_invalid: invalid \.castellan\.yml/);
	});

	it("a PR touching the central file in the central repo escalates", async () => {
		const central = { owner: "o", repo: ".github" };
		const { env } = world(
			{ "o/.github:castellan.yml": "mode: enforce" },
			"castellan.yml",
		);
		const r = await evaluatePull(
			{ ...env, configSource: "central" },
			central,
			3,
			{ dryRun: true },
		);
		expect(reasons(r)).toEqual([
			"castellan_config: touches the central config",
		]);
	});

	it("a PR in the central repo touching another file does not escalate for it", async () => {
		const central = { owner: "o", repo: ".github" };
		const { env } = world(
			{ "o/.github:castellan.yml": "mode: enforce" },
			"README.md",
		);
		const r = await evaluatePull(
			{ ...env, configSource: "central" },
			central,
			3,
			{ dryRun: true },
		);
		expect(reasons(r).join()).not.toContain("central config");
	});

	it("db fails the run loudly", async () => {
		const { env } = world({});
		await expect(
			evaluatePull({ ...env, configSource: "db" }, repo, 3, { dryRun: true }),
		).rejects.toThrow(/db/);
	});

	it("reads the central file once per cache across PRs", async () => {
		const { request, env } = world({
			"o/.github:castellan.yml": "mode: enforce",
		});
		const e = {
			...env,
			configSource: "central" as const,
			centralCache: new Map(),
		};
		await evaluatePull(e, repo, 3, { dryRun: true });
		await evaluatePull(e, repo, 4, { dryRun: true });
		const reads = request.mock.calls.filter(
			([route, p]) =>
				route === "GET /repos/{owner}/{repo}/contents/{path}" &&
				(p as { repo?: string }).repo === ".github",
		);
		expect(reads).toHaveLength(1);
	});
});
