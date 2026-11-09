import { parseConfigSource } from "./adapters/auth.js";
import { appLogin, installationTransport } from "./github.js";
import { createHandler } from "./lambda.js";
import { loadSecrets } from "./secrets.js";

const configSource = parseConfigSource(
	process.env.CASTELLAN_CONFIG_SOURCE || undefined,
	"CASTELLAN_CONFIG_SOURCE",
);
if (configSource === "db")
	throw new Error("config source db is not implemented yet");

export const handler = createHandler({
	repos: (process.env.CASTELLAN_REPOS ?? "")
		.split(",")
		.map((r) => r.trim())
		.filter(Boolean),
	configSource,
	centralLocator: process.env.CASTELLAN_CENTRAL_CONFIG || undefined,
	async loadSecrets() {
		const arn = process.env.CASTELLAN_APP_SECRET_ARN;
		if (!arn) throw new Error("CASTELLAN_APP_SECRET_ARN is not set");
		return loadSecrets(arn);
	},
	async connect(s) {
		const creds = {
			appId: s.app_id,
			privateKey: s.private_key,
			installationId: s.installation_id,
		};
		const [transport, login] = await Promise.all([
			installationTransport(creds),
			appLogin(creds),
		]);
		return { transport, login };
	},
});
