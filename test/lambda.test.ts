import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHandler, type Deps, type LambdaEvent } from "../src/lambda.js";
import { evaluatePull, listWork, triageIssue } from "../src/pipeline.js";

vi.mock("../src/pipeline.js", () => ({
	evaluatePull: vi.fn(async () => "acted"),
	triageIssue: vi.fn(async () => ({ ok: true })),
	listWork: vi.fn(async () => ({ pulls: [1, 2], issues: [9] })),
}));

const SECRET = "whsec";
const secrets = {
	app_id: 1,
	installation_id: 2,
	private_key: "k",
	webhook_secret: SECRET,
};
const repository = {
	id: 100,
	full_name: "o/r",
	owner: { login: "o" },
	name: "r",
};

function setup(repos = ["o/r"]) {
	const transport = { paginate: vi.fn(async (): Promise<unknown[]> => []) };
	const deps = {
		repos,
		loadSecrets: vi.fn(async () => secrets),
		connect: vi.fn(async () => ({ transport, login: "castellan[bot]" })),
	} as unknown as Deps;
	return { deps, transport, handler: createHandler(deps) };
}

const sign = (body: string, secret = SECRET) =>
	`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const hook = (
	name: string,
	payload: object,
	over: { signature?: string; base64?: boolean } = {},
): LambdaEvent => {
	const body = JSON.stringify(payload);
	return {
		headers: {
			"x-github-event": name,
			"x-hub-signature-256": over.signature ?? sign(body),
		},
		body: over.base64 ? Buffer.from(body).toString("base64") : body,
		isBase64Encoded: over.base64 ?? false,
	};
};

beforeEach(() => vi.clearAllMocks());

describe("signature", () => {
	it("rejects a bad signature with 401 before parsing or any GitHub call", async () => {
		const { handler, deps } = setup();
		const event = hook("pull_request", {}, { signature: sign("x", "wrong") });
		event.body = "not json at all";
		expect((await handler(event)).statusCode).toBe(401);
		expect(deps.connect).not.toHaveBeenCalled();
		expect(evaluatePull).not.toHaveBeenCalled();
	});

	it("rejects a missing or wrong-length signature", async () => {
		const { handler } = setup();
		const event = hook("pull_request", {});
		delete event.headers?.["x-hub-signature-256"];
		expect((await handler(event)).statusCode).toBe(401);
		expect(
			(await handler(hook("pull_request", {}, { signature: "sha256=ab" })))
				.statusCode,
		).toBe(401);
	});

	it("rejects a valid signature replayed with a different body", async () => {
		const { handler } = setup();
		const signed = hook("pull_request", {
			action: "opened",
			repository,
			pull_request: { number: 1 },
		});
		const tampered = {
			...signed,
			body: JSON.stringify({
				action: "opened",
				repository,
				pull_request: { number: 999 },
			}),
		};
		expect((await handler(tampered)).statusCode).toBe(401);
		expect(evaluatePull).not.toHaveBeenCalled();
	});

	it("verifies the raw bytes of a base64 body", async () => {
		const { handler } = setup();
		const res = await handler(hook("pull_request", {}, { base64: true }));
		expect(res.statusCode).toBe(200);
	});
});

describe("kill switch and repo filter", () => {
	it("does nothing when CASTELLAN_REPOS is empty", async () => {
		const { handler, deps } = setup([]);
		const res = await handler(hook("pull_request", { repository }));
		expect(res).toEqual({ statusCode: 200, body: "disabled" });
		expect(deps.loadSecrets).not.toHaveBeenCalled();
		expect((await handler({ source: "sweep" })).body).toBe("disabled");
	});

	it("ignores events for other repos", async () => {
		const { handler } = setup();
		const other = { ...repository, full_name: "o/other" };
		const res = await handler(
			hook("pull_request", {
				action: "opened",
				repository: other,
				pull_request: { number: 1 },
			}),
		);
		expect(res.body).toMatch(/not allowed/);
		expect(evaluatePull).not.toHaveBeenCalled();
	});

	it("matches the repo case-insensitively", async () => {
		const { handler } = setup(["O/R"]);
		await handler(
			hook("pull_request", {
				action: "opened",
				repository,
				pull_request: { number: 1 },
			}),
		);
		expect(evaluatePull).toHaveBeenCalledTimes(1);
	});
});

describe("routing", () => {
	const run = async (name: string, payload: object) => {
		const s = setup();
		const res = await s.handler(hook(name, { repository, ...payload }));
		return { ...s, res };
	};
	const ours = { repo: { full_name: "o/r" } };
	const fork = { repo: { full_name: "someone/r" } };
	const pulls = () => vi.mocked(evaluatePull).mock.calls.map((c) => c[2]);

	it.each(["opened", "synchronize", "reopened", "ready_for_review"])(
		"pull_request %s",
		async (action) => {
			await run("pull_request", { action, pull_request: { number: 5 } });
			expect(pulls()).toEqual([5]);
		},
	);

	it("ignores other pull_request actions", async () => {
		const { res } = await run("pull_request", {
			action: "closed",
			pull_request: { number: 5 },
		});
		expect(res.body).toMatch(/^ignored/);
		expect(pulls()).toEqual([]);
	});

	it("pull_request_review submitted, but not our own", async () => {
		const review = (login: string) => ({
			action: "submitted",
			pull_request: { number: 6 },
			review: { user: { login } },
		});
		await run("pull_request_review", review("alice"));
		await run("pull_request_review", review("castellan[bot]"));
		expect(pulls()).toEqual([6]);
	});

	it("check_suite completed routes every attached PR", async () => {
		const check_suite = {
			head_sha: "abc",
			pull_requests: [
				{ number: 7, base: { repo: { id: 100 } } },
				{ number: 8, base: { repo: { id: 100 } } },
				{ number: 1, base: { repo: { id: 999 } } },
			],
		};
		await run("check_suite", { action: "completed", check_suite });
		await run("check_suite", { action: "requested", check_suite });
		expect(pulls()).toEqual([7, 8]);
	});

	it("check_suite from a fork finds PRs by head sha", async () => {
		const s = setup();
		s.transport.paginate.mockResolvedValue([
			{ number: 21, state: "open", head: { sha: "forkhead" }, base: ours },
			{ number: 22, state: "open", head: { sha: "other" }, base: ours },
			{ number: 1, state: "open", head: { sha: "forkhead" }, base: fork },
		]);
		await s.handler(
			hook("check_suite", {
				repository,
				action: "completed",
				check_suite: { head_sha: "forkhead", pull_requests: [] },
			}),
		);
		expect(pulls()).toEqual([21]);
		expect(s.transport.paginate).toHaveBeenCalledWith(
			"GET /repos/{owner}/{repo}/commits/{commit_sha}/pulls",
			expect.objectContaining({
				owner: "o",
				repo: "r",
				commit_sha: "forkhead",
			}),
		);
	});

	it("check_suite with only fork entries falls back to the sha lookup", async () => {
		const s = setup();
		s.transport.paginate.mockResolvedValue([
			{ number: 21, state: "open", head: { sha: "h" }, base: ours },
		]);
		await s.handler(
			hook("check_suite", {
				repository,
				action: "completed",
				check_suite: {
					head_sha: "h",
					pull_requests: [{ number: 1, base: { repo: { id: 999 } } }],
				},
			}),
		);
		expect(pulls()).toEqual([21]);
	});

	it("check_run is not routed", async () => {
		const { res } = await run("check_run", {
			action: "completed",
			check_run: { pull_requests: [{ number: 7 }] },
		});
		expect(res.body).toMatch(/^ignored/);
		expect(pulls()).toEqual([]);
	});

	it("status looks up open PRs on that head", async () => {
		const s = setup();
		s.transport.paginate.mockResolvedValue([
			{ number: 3, state: "open", head: { sha: "abc" }, base: ours },
			{ number: 4, state: "open", head: { sha: "newer" }, base: ours },
			{ number: 5, state: "closed", head: { sha: "abc" }, base: ours },
		]);
		await s.handler(
			hook("status", { repository, sha: "abc", context: "ci/test" }),
		);
		expect(pulls()).toEqual([3]);
	});

	it("status from castellan itself is ignored", async () => {
		const { transport } = await run("status", {
			sha: "abc",
			context: "castellan",
		});
		expect(transport.paginate).not.toHaveBeenCalled();
		expect(pulls()).toEqual([]);
	});

	it("issues opened or labeled triages, other actions do not", async () => {
		const { res } = await run("issues", {
			action: "opened",
			issue: { number: 11 },
		});
		await run("issues", { action: "labeled", issue: { number: 12 } });
		await run("issues", { action: "closed", issue: { number: 13 } });
		expect(res.statusCode).toBe(200);
		expect(vi.mocked(triageIssue).mock.calls.map((c) => [c[1], c[2]])).toEqual([
			[{ owner: "o", repo: "r" }, 11],
			[{ owner: "o", repo: "r" }, 12],
		]);
		expect(evaluatePull).not.toHaveBeenCalled();
	});

	it("issues labeled by castellan itself is ignored, by a human or another label is not", async () => {
		await run("issues", {
			action: "labeled",
			issue: { number: 16 },
			sender: { login: "castellan[bot]" },
		});
		expect(triageIssue).not.toHaveBeenCalled();
		await run("issues", {
			action: "labeled",
			issue: { number: 17 },
			label: { name: "bug" },
			sender: { login: "alice" },
		});
		expect(vi.mocked(triageIssue).mock.calls.map((c) => c[2])).toEqual([17]);
	});

	it("issues labeled on a closed issue or a pull request is ignored", async () => {
		await run("issues", {
			action: "labeled",
			issue: { number: 14, state: "closed" },
		});
		await run("issues", {
			action: "labeled",
			issue: { number: 15, pull_request: {} },
		});
		expect(triageIssue).not.toHaveBeenCalled();
		expect(evaluatePull).not.toHaveBeenCalled();
	});

	it("ignores unrouted events", async () => {
		const { res } = await run("ping", {});
		expect(res.statusCode).toBe(200);
		expect(evaluatePull).not.toHaveBeenCalled();
	});

	it("returns 200 when a job throws; the failure is only logged", async () => {
		vi.mocked(evaluatePull).mockRejectedValueOnce(new Error("boom"));
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { res } = await run("pull_request", {
			action: "opened",
			pull_request: { number: 1 },
		});
		expect(res).toEqual({ statusCode: 200, body: "ok failed=1 skipped=0" });
	});

	it("returns 400 for a correctly signed body that is not json", async () => {
		const { handler } = setup();
		const body = "{nope";
		const res = await handler({
			headers: {
				"x-github-event": "pull_request",
				"x-hub-signature-256": sign(body),
			},
			body,
		});
		expect(res.statusCode).toBe(400);
	});
});

describe("owner/* entries", () => {
	const pr = (full_name: string) => {
		const [owner = "", name = ""] = full_name.split("/");
		return hook("pull_request", {
			action: "opened",
			repository: { id: 1, full_name, owner: { login: owner }, name },
			pull_request: { number: 1 },
		});
	};

	it("accepts any repo of the owner, case-insensitively, and ignores others", async () => {
		const { handler } = setup(["Agent-Of-Empires/*", "x/exact"]);
		await handler(pr("agent-of-empires/anything"));
		await handler(pr("x/exact"));
		expect(evaluatePull).toHaveBeenCalledTimes(2);
		const res = await handler(pr("other-org/x"));
		expect(res.body).toMatch(/not allowed/);
		expect((await handler(pr("x/other"))).body).toMatch(/not allowed/);
		expect(evaluatePull).toHaveBeenCalledTimes(2);
	});

	it("sweeps installation repos of the owner, skipping archived and other owners, deduping exact entries", async () => {
		const { handler, transport } = setup(["o/*", "o/a"]);
		const repo = (full_name: string, archived = false) => ({
			full_name,
			archived,
			owner: { login: full_name.split("/")[0] },
		});
		transport.paginate.mockResolvedValue([
			repo("o/a"),
			repo("o/b"),
			repo("o/old", true),
			repo("p/c"),
		]);
		await handler({ source: "sweep" });
		expect(transport.paginate).toHaveBeenCalledWith(
			"GET /installation/repositories",
			{ per_page: 100 },
		);
		expect(vi.mocked(listWork).mock.calls.map((c) => c[1])).toEqual([
			{ owner: "o", repo: "a" },
			{ owner: "o", repo: "b" },
		]);
	});
});

describe("non-wildcard patterns", () => {
	it.each(["*", "*/*", "o/pre*"])("%s is not a wildcard", async (entry) => {
		const { handler } = setup([entry]);
		const res = await handler(
			hook("pull_request", {
				action: "opened",
				repository: { ...repository, full_name: "o/prefix", name: "prefix" },
				pull_request: { number: 1 },
			}),
		);
		expect(res.body).toMatch(/not allowed/);
		expect(evaluatePull).not.toHaveBeenCalled();
	});
});

describe("sweep", () => {
	it("still sweeps exact entries when the installation listing fails, and replies 500", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { handler, transport } = setup(["o/*", "x/y"]);
		transport.paginate.mockRejectedValue(new Error("rate limited"));
		const res = await handler({ source: "sweep" });
		expect(res.statusCode).toBe(500);
		expect(console.error).toHaveBeenCalledWith(
			"sweep: listing installation repos failed",
			expect.any(Error),
		);
		expect(vi.mocked(listWork).mock.calls.map((c) => c[1])).toEqual([
			{ owner: "x", repo: "y" },
		]);
	});

	it("runs the pipeline for every open PR and needs-triage issue", async () => {
		const { handler } = setup();
		const res = await handler({ source: "sweep" });
		expect(res.statusCode).toBe(200);
		expect(vi.mocked(listWork).mock.calls[0]?.[1]).toEqual({
			owner: "o",
			repo: "r",
		});
		expect(vi.mocked(evaluatePull).mock.calls.map((c) => c[2])).toEqual([1, 2]);
		expect(vi.mocked(triageIssue).mock.calls.map((c) => c[2])).toEqual([9]);
	});

	it("keeps going when one repo fails", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.mocked(listWork).mockRejectedValueOnce(new Error("nope"));
		const { handler } = setup(["o/a", "o/r"]);
		const res = await handler({ source: "sweep" });
		expect(res.statusCode).toBe(500);
		expect(evaluatePull).toHaveBeenCalledTimes(2);
	});
});

describe("deadline and concurrency", () => {
	const pullsOf = (n: number) =>
		vi.mocked(listWork).mockResolvedValueOnce({
			pulls: Array.from({ length: n }, (_, i) => i + 1),
			issues: [],
		});

	it("stops starting jobs when the remaining time runs low", async () => {
		pullsOf(6);
		const ctx = {
			getRemainingTimeInMillis: () =>
				vi.mocked(evaluatePull).mock.calls.length >= 2 ? 10_000 : 100_000,
		};
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { handler } = setup();
		const res = await handler({ source: "sweep" }, ctx);
		expect(res.statusCode).toBe(200);
		expect(evaluatePull).toHaveBeenCalledTimes(2);
	});

	it("starts nothing when already out of time", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { handler } = setup();
		await handler(
			{ source: "sweep" },
			{ getRemainingTimeInMillis: () => 5_000 },
		);
		expect(listWork).not.toHaveBeenCalled();
		expect(evaluatePull).not.toHaveBeenCalled();
	});

	it("runs at most 3 jobs at once", async () => {
		pullsOf(8);
		let live = 0;
		let peak = 0;
		vi.mocked(evaluatePull).mockImplementation(async () => {
			peak = Math.max(peak, ++live);
			await new Promise((r) => setTimeout(r, 5));
			live--;
			return { status: "acted" };
		});
		const { handler } = setup();
		await handler({ source: "sweep" }, { getRemainingTimeInMillis: () => 1e6 });
		expect(evaluatePull).toHaveBeenCalledTimes(8);
		expect(peak).toBe(3);
	});
});

describe("infrastructure failures", () => {
	const event = () =>
		hook("pull_request", {
			action: "opened",
			repository,
			pull_request: { number: 1 },
		});

	it("returns 500, not a throw, and retries the secret load next time", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { handler, deps } = setup();
		vi.mocked(deps.loadSecrets).mockRejectedValueOnce(new Error("sm down"));
		expect((await handler(event())).statusCode).toBe(500);
		expect((await handler(event())).statusCode).toBe(200);
		expect(deps.loadSecrets).toHaveBeenCalledTimes(2);
	});

	it("retries a failed connect too", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { handler, deps } = setup();
		vi.mocked(deps.connect).mockRejectedValueOnce(new Error("app down"));
		expect((await handler(event())).statusCode).toBe(500);
		expect((await handler(event())).statusCode).toBe(200);
		expect(deps.loadSecrets).toHaveBeenCalledTimes(1);
		expect(deps.connect).toHaveBeenCalledTimes(2);
	});

	it("a failed sweep listing is a 500", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.mocked(listWork).mockRejectedValueOnce(new Error("gh down"));
		const { handler } = setup();
		expect((await handler({ source: "sweep" })).statusCode).toBe(500);
	});
});

describe("container cache", () => {
	it("fetches secrets and connects once across invocations", async () => {
		const { handler, deps } = setup();
		const event = () =>
			hook("pull_request", {
				action: "opened",
				repository,
				pull_request: { number: 1 },
			});
		await handler(event());
		await handler(event());
		expect(deps.loadSecrets).toHaveBeenCalledTimes(1);
		expect(deps.connect).toHaveBeenCalledTimes(1);
	});
});

it("rejects an unknown invocation shape", async () => {
	const { handler } = setup();
	expect((await handler({})).statusCode).toBe(400);
});
