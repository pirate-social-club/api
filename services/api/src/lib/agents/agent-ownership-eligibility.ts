import type { Client } from "../sql-client"
import { getUserRow } from "../auth/auth-db-user-queries"
import { parseVerificationCapabilities } from "../auth/auth-serializers"
import { conflictError, internalError, notImplementedError, verificationRequired } from "../errors"
import { countActiveUserAgentsForOwner } from "./agent-ownership-queries"

export function assertRegisterOnly(sessionKind: string): asserts sessionKind is "register" {
  if (sessionKind !== "register") {
    throw notImplementedError("Only register agent ownership sessions are implemented in this slice")
  }
}

export function assertClawkeyOnly(provider: string): asserts provider is "clawkey" {
  if (provider !== "clawkey") {
    throw notImplementedError("Only the clawkey ownership provider is implemented in this slice")
  }
}

export async function ensureEligibleOwner(client: Client, userId: string): Promise<void> {
  const userRow = await getUserRow(client, userId)
  if (!userRow) {
    throw internalError("User row is missing")
  }
  const capabilities = parseVerificationCapabilities(userRow.verification_capabilities_json)
  if (capabilities.unique_human.state !== "verified") {
    throw verificationRequired("unique_human verification is required before starting agent ownership")
  }
}

export async function ensureEligibleOwnerCanRegisterAgent(client: Client, userId: string): Promise<void> {
  await ensureEligibleOwner(client, userId)
  const activeAgentCount = await countActiveUserAgentsForOwner(client, userId)
  if (activeAgentCount >= 1) {
    throw conflictError("Public v0 allows only one active user-owned agent per verified human")
  }
}

