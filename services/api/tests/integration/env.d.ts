import type { CommentCreateRateLimiterDO } from "../../src/lib/comment-create-rate-limit"
import type { StorySettlementWalletCoordinatorDO } from "../../src/lib/story/story-settlement-wallet-coordinator-do"

// Augments the @cloudflare/vitest-pool-workers test env with the karaoke
// bindings declared in vitest.config.ts, plus the D1 shard pilot binding used
// by the shard integration tests, so the integration tests typecheck.
declare module "cloudflare:test" {
  interface ProvidedEnv {
    KARAOKE_SESSION_RUNTIME: DurableObjectNamespace
    OPERATOR_SIGNING_COORDINATOR: DurableObjectNamespace
    STORY_SETTLEMENT_WALLET_COORDINATOR: DurableObjectNamespace<StorySettlementWalletCoordinatorDO>
    COMMENT_CREATE_RATE_LIMITER: DurableObjectNamespace<CommentCreateRateLimiterDO>
    KARAOKE_GATEWAY_SIGNING_KEY: string
    DB_CMTY_PILOT: D1Database
  }
}

export {}
