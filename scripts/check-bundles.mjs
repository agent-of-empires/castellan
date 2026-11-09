// Imports each built bundle from a plain .mjs context, which is what catches a
// missing require() shim, and checks the CLI starts.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

for (const file of [
	"dist/lambda/index.mjs",
	"dist/action/index.mjs",
	"dist/cli/index.mjs",
]) {
	await import(pathToFileURL(resolve(file)).href);
	console.log(`imported ${file}`);
}

const help = spawnSync("node", ["dist/cli/index.mjs", "--help"], {
	encoding: "utf8",
});
if (help.status !== 0 || !help.stdout.includes("usage: castellan")) {
	console.error(help.stderr || help.stdout);
	process.exit(1);
}
console.log("cli --help ok");
