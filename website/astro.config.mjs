import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

export default defineConfig({
	site: "https://castellan.agent-of-empires.com",
	integrations: [sitemap()],
});
