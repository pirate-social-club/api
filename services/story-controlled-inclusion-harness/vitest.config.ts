import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		include: ["test/**/*.integration.test.ts"],
		poolOptions: {
			workers: {
				wrangler: { configPath: "./wrangler.jsonc" },
				miniflare: {
					bindings: {
						ENVIRONMENT: "test",
						UPSTREAM_RPC_URL: "https://aeneid.test.invalid",
					},
				},
			},
		},
	},
});
