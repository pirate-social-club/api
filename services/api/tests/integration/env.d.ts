// Augments the @cloudflare/vitest-pool-workers test env with the karaoke
// bindings declared in vitest.config.ts, so the integration test typechecks.
declare module "cloudflare:test" {
  interface ProvidedEnv {
    KARAOKE_SESSION_RUNTIME: DurableObjectNamespace
    KARAOKE_GATEWAY_SIGNING_KEY: string
    DB_CMTY_PILOT: D1Database
  }
}

export {}
