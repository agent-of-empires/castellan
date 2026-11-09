import { Octokit } from "octokit";
import type { Config } from "../config.js";
import { appLogin, installationTransport } from "../github.js";
import type { Env } from "../pipeline.js";

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
	/** Token path only: the login castellan acts as. An App's login comes from `GET /app`. */
	botLogin?: string;
}

/** App credentials win over a token. */
export async function resolveAuth(
	i: AuthInput,
): Promise<Pick<Env, "transport" | "login">> {
	if (i.appId || i.installationId || i.privateKey) {
		if (!(i.appId && i.installationId && i.privateKey)) {
			throw new Error("app auth needs app id, installation id and private key");
		}
		const creds = {
			appId: Number(i.appId),
			installationId: Number(i.installationId),
			privateKey: i.privateKey,
		};
		return {
			transport: await installationTransport(creds),
			login: await appLogin(creds),
		};
	}
	if (!i.token) {
		throw new Error(
			"set GITHUB_TOKEN, or CASTELLAN_APP_ID, CASTELLAN_INSTALLATION_ID and CASTELLAN_PRIVATE_KEY",
		);
	}
	return {
		transport: new Octokit({ auth: i.token }),
		login: i.botLogin ?? "github-actions[bot]",
	};
}
