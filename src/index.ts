import { appLogin, installationTransport } from "./github.js";
import { createHandler } from "./lambda.js";
import { loadSecrets } from "./secrets.js";

export const handler = createHandler({
	repos: (process.env.CASTELLAN_REPOS ?? "")
		.split(",")
		.map((r) => r.trim())
		.filter(Boolean),
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
