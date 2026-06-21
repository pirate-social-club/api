import { describe, expect, test } from "bun:test"
import { getControlPlaneAgentOwnershipRepository } from "../src/lib/agents/agent-ownership-repository"
import { getControlPlaneVerificationRepository } from "../src/lib/verification/verification-repository"
import { withRequestControlPlaneClients } from "../src/lib/runtime-deps"

describe("control-plane repository factories", () => {
  test("do not cache request-scoped Postgres verification repositories", async () => {
    const env = {
      CONTROL_PLANE_DATABASE_URL: "postgresql://user:pass@example.invalid/pirate",
      ENVIRONMENT: "production",
    } as never

    await withRequestControlPlaneClients(async () => {
      const first = getControlPlaneVerificationRepository(env)
      const second = getControlPlaneVerificationRepository(env)

      expect(second).not.toBe(first)
    })
  })

  test("do not cache request-scoped Postgres agent ownership repositories", async () => {
    const env = {
      CONTROL_PLANE_DATABASE_URL: "postgresql://user:pass@example.invalid/pirate",
      ENVIRONMENT: "production",
    } as never

    await withRequestControlPlaneClients(async () => {
      const first = getControlPlaneAgentOwnershipRepository(env)
      const second = getControlPlaneAgentOwnershipRepository(env)

      expect(second).not.toBe(first)
    })
  })
})
