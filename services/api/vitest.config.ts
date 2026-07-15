import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config"

// Phase 3 — workerd/Miniflare integration tests for the karaoke WebSocket
// gateway + Durable Object. Scoped to `tests/integration/**` and run via the
// `test:integration` script. The existing `bun test` suites are untouched:
// these files use the `.integration.ts` suffix so `bun test` ignores them.
export default defineWorkersConfig({
  test: {
    include: ["tests/integration/**/*.integration.ts"],
    exclude: ["tests/integration/operator-signing-coordinator.integration.ts"],
    poolOptions: {
      workers: {
        main: "./tests/integration/karaoke-gateway.worker.ts",
        // Each test allocates a unique session id (nextFixture), so per-test
        // storage isolation is unnecessary. Disabling it also avoids a known
        // teardown bug where SQLite WAL side-files (.sqlite-shm/-wal) break the
        // isolated-storage stack pop for SQLite-backed Durable Objects.
        isolatedStorage: false,
        miniflare: {
          // The installed Workers runtime caps the compatibility date at
          // 2025-09-06; requesting a later date only logs a fallback warning.
          compatibilityDate: "2025-09-06",
          compatibilityFlags: ["nodejs_compat"],
          durableObjects: {
            KARAOKE_SESSION_RUNTIME: {
              className: "KaraokeSessionRuntimeDO",
              useSQLite: true,
            },
          },
          d1Databases: {
            DB_CMTY_PILOT: "DB_CMTY_PILOT",
            D1_POOL: "D1_POOL",
          },
          bindings: {
            ENVIRONMENT: "test",
            // 48 chars — exceeds the 32-char minimum enforced by the signer.
            KARAOKE_GATEWAY_SIGNING_KEY: "integration-test-karaoke-gateway-signing-key-001",
            CORS_ALLOWED_ORIGINS: "http://localhost:5173",
          },
        },
      },
    },
  },
})
