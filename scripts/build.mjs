import { rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });

// bundled CJS deps (the SDKs, yaml) call require() on Node builtins
const requireShim =
	'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);';

const common = {
	bundle: true,
	platform: "node",
	target: "node22",
	format: "esm",
	banner: { js: requireShim },
};

// No sourcemap: it is 9 MB and Lambda does not load it without --enable-source-maps.
await build({
	...common,
	entryPoints: ["src/index.ts"],
	outfile: "dist/lambda/index.mjs",
});

await build({
	...common,
	entryPoints: ["src/eval-cli.ts"],
	outfile: "dist/eval.mjs",
	sourcemap: true,
});

// Self-hosting adapters; kept out of the Lambda bundle.
await build({
	...common,
	entryPoints: ["src/adapters/action.ts"],
	outfile: "dist/action/index.mjs",
});
await build({
	...common,
	entryPoints: ["src/adapters/cli.ts"],
	outfile: "dist/cli/index.mjs",
	banner: { js: `#!/usr/bin/env node\n${requireShim}` },
});
