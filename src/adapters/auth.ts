import { Octokit } from "octokit";
import { installationTransport } from "../github.js";
import type { RunDeps } from "../run.js";

export interface AuthInput {
	token?: string;
	appId?: string;
	installationId?: string;
	privateKey?: string;
	/** The identity castellan acts as: `<slug>[bot]` for an App, `github-actions[bot]` for the workflow token. */
	botLogin?: string;
}

/** App credentials win over a token. An App must name its bot login, so its own approval is found again. */
export async function resolveAuth(
	i: AuthInput,
): Promise<Pick<RunDeps, "transport" | "author">> {
	if (i.appId || i.installationId || i.privateKey) {
		if (!(i.appId && i.installationId && i.privateKey && i.botLogin)) {
			throw new Error(
				"app auth needs app id, installation id, private key and bot login",
			);
		}
		return {
			transport: await installationTransport({
				appId: Number(i.appId),
				installationId: Number(i.installationId),
				privateKey: i.privateKey,
			}),
			author: { login: i.botLogin },
		};
	}
	if (!i.token) {
		throw new Error("set a token, or app id, installation id and private key");
	}
	return {
		transport: new Octokit({ auth: i.token }),
		author: { login: i.botLogin ?? "github-actions[bot]" },
	};
}
