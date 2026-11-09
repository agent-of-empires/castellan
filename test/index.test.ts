import { expect, it } from "vitest";

it("loads the entry point as an ES module", async () => {
	expect(await import("../src/index.js")).toBeDefined();
});
