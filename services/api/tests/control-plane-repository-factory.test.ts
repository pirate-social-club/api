import { describe, expect, test } from "bun:test"
import { getControlPlaneAgentOwnershipRepository } from "../src/lib/agents/agent-ownership-repository"
import { getControlPlaneVerificationRepository } from "../src/lib/verification/verification-repository"
import { withRequestControlPlaneClients } from "../src/lib/runtime-deps"

const PRODUCTION_POSTGRES_ENV = {
  CONTROL_PLANE_DATABASE_URL: "postgresql://user:pass@example.invalid/pirate",
  CONTROL_PLANE_HYPERDRIVE: {
    connectionString: "postgresql://hyperdrive.invalid/pirate",
  },
  ENVIRONMENT: "production",
} as never

describe("control-plane repository factories", () => {
  test("do not cache request-scoped Postgres verification repositories", async () => {
    await withRequestControlPlaneClients(async () => {
      const first = getControlPlaneVerificationRepository(PRODUCTION_POSTGRES_ENV)
      const second = getControlPlaneVerificationRepository(PRODUCTION_POSTGRES_ENV)

      expect(second).not.toBe(first)
    })
  })

  test("do not cache request-scoped Postgres agent ownership repositories", async () => {
    await withRequestControlPlaneClients(async () => {
      const first = getControlPlaneAgentOwnershipRepository(PRODUCTION_POSTGRES_ENV)
      const second = getControlPlaneAgentOwnershipRepository(PRODUCTION_POSTGRES_ENV)

      expect(second).not.toBe(first)
    })
  })
})
