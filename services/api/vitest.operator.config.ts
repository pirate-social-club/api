import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config"

export default defineWorkersConfig({
  test: {
    include: ["tests/integration/operator-signing-coordinator.integration.ts"],
    poolOptions: {
      workers: {
        main: "./tests/integration/operator-executor.worker.ts",
        isolatedStorage: false,
        miniflare: {
          compatibilityDate: "2025-09-06",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            OPERATOR_SIGNING_COORDINATOR: {
              className: "OperatorSigningCoordinatorDO",
              useSQLite: true,
            },
          },
          bindings: { ENVIRONMENT: "test" },
        },
      },
    },
  },
})
