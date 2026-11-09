import { Octokit } from "octokit";
import type { Config } from "../config.js";
import { installationTransport } from "../github.js";
import type { RunDeps } from "../run.js";

const MODES = ["off", "shadow", "enforce"];

/** Exact match only: act.ts treats anything but `off` and `shadow` as enforce, so a typo must not get through. */
export function parseMode(
	value: string | undefined,
	source: string,
): Config["mode"] | undefined {
	if (value === undefined) return undefined;
	if (!MODES.includes(value)) {
		throw new Error(`${source} must be one of ${MODES.join(", ")}`);
	}
	return value as Config["mode"];
}

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
		throw new Error(
			"set GITHUB_TOKEN, or CASTELLAN_APP_ID, CASTELLAN_INSTALLATION_ID and CASTELLAN_PRIVATE_KEY",
		);
	}
	return {
		transport: new Octokit({ auth: i.token }),
		author: { login: i.botLogin ?? "github-actions[bot]" },
	};
}
