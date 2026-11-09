import { createHash, createHmac } from "node:crypto";
import { assertNoReplace, parseDoc } from "./config.js";
import type { GithubTransport } from "./github.js";

export const CONFIG_SOURCES = ["repo", "central", "db"] as const;
export type ConfigSource = (typeof CONFIG_SOURCES)[number];

export const CENTRAL_PATH = "castellan.yml";

export type CentralLocation =
	| { kind: "git"; owner: string; repo: string; path: string }
	| { kind: "s3"; bucket: string; key: string };

export type CentralResult =
	| { ok: true; doc: Record<string, unknown> }
	| { ok: false; error: string };

/** `owner/repo:path`, `s3://bucket/key`, or unset for `<owner>/.github`. Throws on a malformed value. */
export function parseLocator(
	locator: string | undefined,
	owner: string,
): CentralLocation {
	if (!locator)
		return { kind: "git", owner, repo: ".github", path: CENTRAL_PATH };
	if (locator.startsWith("s3://")) {
		const [bucket, ...key] = locator.slice(5).split("/");
		if (!(bucket && key.join("/"))) {
			throw new Error(
				`CASTELLAN_CENTRAL_CONFIG ${locator} must be s3://bucket/key`,
			);
		}
		return { kind: "s3", bucket, key: key.join("/") };
	}
	const [slug = "", ...rest] = locator.split(":");
	const [o, repo, ...extra] = slug.split("/");
	if (!(o && repo) || extra.length) {
		throw new Error(
			`CASTELLAN_CENTRAL_CONFIG ${locator} must be owner/repo[:path] or s3://bucket/key`,
		);
	}
	return {
		kind: "git",
		owner: o,
		repo,
		path: rest.join(":").replace(/^\/+/, "") || CENTRAL_PATH,
	};
}

const label = (loc: CentralLocation) =>
	loc.kind === "s3"
		? `s3://${loc.bucket}/${loc.key}`
		: `${loc.owner}/${loc.repo}:${loc.path}`;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const hmac = (key: string | Buffer, s: string) =>
	createHmac("sha256", key).update(s).digest();
const encode = (s: string) =>
	encodeURIComponent(s).replace(
		/[!'()*]/g,
		(c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
	);

export interface AwsCreds {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

/** SigV4 headers for an S3 GET with an empty body. `extra` headers are signed too. */
export function signS3Get(
	url: URL,
	region: string,
	creds: AwsCreds,
	now: Date,
	extra: Record<string, string> = {},
): Record<string, string> {
	const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
	const day = amzDate.slice(0, 8);
	const headers: Record<string, string> = {
		...extra,
		host: url.host,
		"x-amz-content-sha256": sha256(""),
		"x-amz-date": amzDate,
		...(creds.sessionToken && { "x-amz-security-token": creds.sessionToken }),
	};
	const names = Object.keys(headers).sort();
	const canonical = [
		"GET",
		url.pathname,
		"",
		names.map((n) => `${n}:${headers[n]?.trim()}\n`).join(""),
		names.join(";"),
		sha256(""),
	].join("\n");
	const scope = `${day}/${region}/s3/aws4_request`;
	const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join(
		"\n",
	);
	const key = ["s3", "aws4_request"].reduce(
		(k, part) => hmac(k, part),
		hmac(hmac(`AWS4${creds.secretAccessKey}`, day), region),
	);
	const signature = createHmac("sha256", key).update(toSign).digest("hex");
	return {
		...headers,
		authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
	};
}

/** Null on 404; any other failure throws. Credentials and region come from the standard AWS env vars. */
async function readS3(
	{ bucket, key }: { bucket: string; key: string },
	fetchImpl: typeof fetch,
	env: NodeJS.ProcessEnv,
): Promise<string | null> {
	const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN } = env;
	const region = env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
	if (!(AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY && region)) {
		throw new Error("AWS credentials and AWS_REGION are not set");
	}
	const url = new URL(
		`https://s3.${region}.amazonaws.com/${bucket}/${key.split("/").map(encode).join("/")}`,
	);
	const res = await fetchImpl(url, {
		headers: signS3Get(
			url,
			region,
			{
				accessKeyId: AWS_ACCESS_KEY_ID,
				secretAccessKey: AWS_SECRET_ACCESS_KEY,
				sessionToken: AWS_SESSION_TOKEN,
			},
			new Date(),
		),
	});
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`S3 returned ${res.status}`);
	return res.text();
}

async function readGit(
	transport: GithubTransport,
	{ owner, repo, path }: { owner: string; repo: string; path: string },
): Promise<string | null> {
	try {
		const { data } = await transport.request(
			"GET /repos/{owner}/{repo}/contents/{path}",
			{ owner, repo, path, mediaType: { format: "raw" } },
		);
		return data as unknown as string;
	} catch (err) {
		if ((err as { status?: number }).status === 404) return null;
		throw err;
	}
}

export interface CentralDeps {
	transport: GithubTransport;
	fetch?: typeof fetch;
	/** Memo for one invocation, keyed by resolved location. */
	cache?: Map<string, Promise<CentralResult>>;
}

/** The central document, or an error that must escalate every PR of the owner. A missing file is an error. */
export function loadCentral(
	deps: CentralDeps,
	loc: CentralLocation,
	env: NodeJS.ProcessEnv = process.env,
): Promise<CentralResult> {
	const id = label(loc);
	const hit = deps.cache?.get(id);
	if (hit) return hit;
	const run = async (): Promise<CentralResult> => {
		try {
			const text =
				loc.kind === "s3"
					? await readS3(loc, deps.fetch ?? fetch, env)
					: await readGit(deps.transport, loc);
			if (text === null)
				return { ok: false, error: `central config ${id} not found` };
			const doc = parseDoc(text, "central file");
			assertNoReplace(doc, "central file");
			return { ok: true, doc };
		} catch (e) {
			return {
				ok: false,
				error: `cannot read central config ${id}: ${e instanceof Error ? e.message : String(e)}`,
			};
		}
	};
	const p = run();
	deps.cache?.set(id, p);
	return p;
}

/** Owners whose central repo is a git repo outside the allowlist, so castellan never sees PRs that edit it. */
export function centralWarnings(
	repos: string[],
	locator: string | undefined,
): string[] {
	const allowed = repos.map((r) => r.toLowerCase());
	const isAllowed = (o: string, r: string) =>
		allowed.includes(`${o}/${r}`.toLowerCase()) ||
		allowed.includes(`${o}/*`.toLowerCase());
	const owners = [...new Set(repos.map((r) => r.split("/")[0] ?? ""))];
	const locs = locator
		? [parseLocator(locator, "")]
		: owners.map((o) => parseLocator(undefined, o));
	return locs.flatMap((l) =>
		l.kind === "git" && !isAllowed(l.owner, l.repo)
			? [
					`central config repo ${l.owner}/${l.repo} is not in CASTELLAN_REPOS; PRs that edit ${l.path} will not escalate`,
				]
			: [],
	);
}
