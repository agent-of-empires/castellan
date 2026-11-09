import { rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });

const common = {
	bundle: true,
	platform: "node",
	target: "node22",
	format: "esm",
	// bundled CJS deps (the SDKs, yaml) call require() on Node builtins
	banner: {
		js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
	},
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
