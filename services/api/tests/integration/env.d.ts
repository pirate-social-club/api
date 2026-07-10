// Augments the @cloudflare/vitest-pool-workers test env with the karaoke
// bindings declared in vitest.config.ts, plus the D1 shard pilot binding used
// by the shard integration tests, so the integration tests typecheck.
import type { OperatorSigningCoordinatorDO } from "../../src/lib/bookings/operator-signing-coordinator-do"

declare module "cloudflare:test" {
  interface ProvidedEnv {
    KARAOKE_SESSION_RUNTIME: DurableObjectNamespace
    OPERATOR_SIGNING_COORDINATOR: DurableObjectNamespace<OperatorSigningCoordinatorDO>
    KARAOKE_GATEWAY_SIGNING_KEY: string
    DB_CMTY_PILOT: D1Database
  }
}

export {}
