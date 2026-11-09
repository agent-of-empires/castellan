import { rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });

const common = {
	bundle: true,
	platform: "node",
	target: "node22",
	format: "esm",
	sourcemap: true,
};

await build({
	...common,
	entryPoints: ["src/index.ts"],
	outfile: "dist/lambda/index.mjs",
});

await build({
	...common,
	entryPoints: ["src/eval-cli.ts"],
	outfile: "dist/eval.mjs",
	// bundled CJS deps (yaml) call require()
	banner: {
		js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
	},
});
