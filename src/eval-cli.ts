import { readdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Octokit } from "octokit";
import {
	collectCases,
	type EvalCase,
	mistakes,
	recordReviews,
	renderReport,
	replay,
} from "./eval.js";
import { createGithubClient } from "./github.js";
import { review } from "./llm.js";

const { values } = parseArgs({
	options: {
		repo: { type: "string" },
		since: { type: "string", default: "90d" },
		fixtures: { type: "string", default: "eval/fixtures" },
		out: { type: "string" },
		save: { type: "boolean", default: false },
	},
});

async function loadFixtures(dir: string): Promise<EvalCase[]> {
	const names = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
	return Promise.all(
		names.map(async (f) => JSON.parse(await readFile(`${dir}/${f}`, "utf8"))),
	);
}

let cases: EvalCase[];
let title = "Castellan eval: fixtures";
if (values.repo) {
	const [owner, repo] = values.repo.split("/");
	const days = /^(\d+)d$/.exec(values.since ?? "")?.[1];
	if (!owner || !repo || !days) {
		throw new Error("usage: eval --repo <owner/repo> --since <N>d");
	}
	const transport = new Octokit({ auth: process.env.GITHUB_TOKEN });
	cases = await collectCases(
		transport,
		createGithubClient(transport, { owner, repo }),
		{ owner, repo },
		Number(days),
	);
	cases = await recordReviews(cases, (input, config) =>
		review(input, config, { apiKey: process.env.ANTHROPIC_API_KEY }),
	);
	title = `Castellan eval: ${values.repo}, last ${days} days`;
} else {
	cases = await loadFixtures(values.fixtures ?? "eval/fixtures");
}

const results = await replay(cases);
const report = renderReport(results, title);
console.log(report);
if (values.out) await writeFile(values.out, report);
if (values.repo && values.save) {
	for (const r of mistakes(results)) {
		const file = `${values.fixtures}/${r.case.name.replace(/\W+/g, "-")}.json`;
		await writeFile(file, `${JSON.stringify(r.case, null, "\t")}\n`);
	}
}
// fail on any merge verdict humans did not merge as-is
process.exitCode = mistakes(results).length ? 1 : 0;
