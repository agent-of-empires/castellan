import { rm } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });

await build({
	entryPoints: ["src/index.ts"],
	outfile: "dist/lambda/index.mjs",
	bundle: true,
	platform: "node",
	target: "node22",
	format: "esm",
	sourcemap: true,
});
