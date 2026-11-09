import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.resetModules();
});

it("loads the entry point as an ES module", async () => {
	expect((await import("../src/index.js")).handler).toBeTypeOf("function");
});

it("a missing secret ARN is a 500 at invocation, not an import error", async () => {
	vi.stubEnv("CASTELLAN_REPOS", "o/r");
	vi.stubEnv("CASTELLAN_APP_SECRET_ARN", "");
	vi.spyOn(console, "error").mockImplementation(() => {});
	const { handler } = await import("../src/index.js");
	const res = await handler({ headers: {}, body: "{}" });
	expect(res.statusCode).toBe(500);
});
