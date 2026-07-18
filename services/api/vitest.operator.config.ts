import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config"

export default defineWorkersConfig({
  test: {
    include: [
      "tests/integration/crl.integration.ts",
      "tests/integration/operator-signing-coordinator.integration.ts",
      "tests/integration/story-wallet.integration.ts",
    ],
    poolOptions: {
      workers: {
        main: "./tests/integration/operator-executor.worker.ts",
        isolatedStorage: false,
        miniflare: {
          compatibilityDate: "2025-09-06",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            COMMENT_CREATE_RATE_LIMITER: {
              className: "CommentCreateRateLimiterDO",
              useSQLite: true,
            },
            OPERATOR_SIGNING_COORDINATOR: {
              className: "OperatorSigningCoordinatorDO",
              useSQLite: true,
            },
            STORY_SETTLEMENT_WALLET_COORDINATOR: {
              className: "StorySettlementWalletCoordinatorDO",
              useSQLite: true,
            },
          },
          bindings: {
            ENVIRONMENT: "test",
            STORY_COORDINATOR_REPLACEMENT_MIN_BUMP_BPS: "1000",
            STORY_COORDINATOR_MAX_FEE_PER_GAS_WEI: "1000000000",
            STORY_COORDINATOR_MAX_PRIORITY_FEE_PER_GAS_WEI: "500000000",
          },
        },
      },
    },
  },
})
