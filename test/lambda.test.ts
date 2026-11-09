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

	it.each(["check_suite", "check_run"])(
		"%s completed routes every attached PR",
		async (name) => {
			const attached = { pull_requests: [{ number: 7 }, { number: 8 }] };
			await run(name, {
				action: "completed",
				[name]: attached,
			});
			await run(name, { action: "created", [name]: attached });
			expect(pulls()).toEqual([7, 8]);
		},
	);

	it("status looks up open PRs on that head", async () => {
		const s = setup();
		s.transport.paginate.mockResolvedValue([
			{ number: 3, state: "open", head: { sha: "abc" } },
			{ number: 4, state: "open", head: { sha: "newer" } },
			{ number: 5, state: "closed", head: { sha: "abc" } },
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

	it("issues opened triages, other actions do not", async () => {
		await run("issues", { action: "opened", issue: { number: 11 } });
		await run("issues", { action: "labeled", issue: { number: 12 } });
		expect(vi.mocked(triageIssue).mock.calls.map((c) => c[2])).toEqual([11]);
	});

	it("ignores unrouted events", async () => {
		const { res } = await run("ping", {});
		expect(res.statusCode).toBe(200);
		expect(evaluatePull).not.toHaveBeenCalled();
	});

	it("returns 500 when a job throws", async () => {
		vi.mocked(evaluatePull).mockRejectedValueOnce(new Error("boom"));
		vi.spyOn(console, "error").mockImplementation(() => {});
		const { res } = await run("pull_request", {
			action: "opened",
			pull_request: { number: 1 },
		});
		expect(res.statusCode).toBe(500);
	});
});

describe("sweep", () => {
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
