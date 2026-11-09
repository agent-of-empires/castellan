import { describe, expect, it, vi } from "vitest";
import { loadSecrets } from "../src/secrets.js";

const client = (SecretString?: string) => ({
	send: vi.fn(async () => ({ SecretString })),
});

describe("loadSecrets", () => {
	it("parses the JSON secret and coerces numeric ids", async () => {
		const c = client(
			JSON.stringify({
				app_id: "12",
				installation_id: 34,
				private_key: "pem",
				webhook_secret: "s",
			}),
		);
		expect(await loadSecrets("arn:x", c)).toEqual({
			app_id: 12,
			installation_id: 34,
			private_key: "pem",
			webhook_secret: "s",
		});
		const cmd = c.send.mock.calls[0] as unknown as [{ input: unknown }];
		expect(cmd[0].input).toEqual({ SecretId: "arn:x" });
	});

	it("rejects a secret with a missing key", async () => {
		await expect(
			loadSecrets("arn:x", client(JSON.stringify({ app_id: 1 }))),
		).rejects.toThrow();
	});

	it("rejects a binary secret", async () => {
		await expect(loadSecrets("arn:x", client())).rejects.toThrow();
	});
});
