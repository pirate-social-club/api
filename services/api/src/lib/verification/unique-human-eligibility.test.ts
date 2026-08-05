import { describe, expect, test } from "bun:test"
import { resolveActiveRewardIdentity, resolveActiveSupportedRewardIdentity } from "./unique-human-eligibility"
import type { InStatement, QueryResult } from "../sql-client"

function client(input: { verifiedAt: number; provider?: string; nullifier?: string }) {
  let calls = 0
  return {
    get calls() { return calls },
    async execute(_statement: InStatement | string): Promise<QueryResult> {
      calls += 1
      if (calls === 1) {
        return { rows: [{ verification_capabilities_json: JSON.stringify({
          unique_human: {
            state: "verified",
            provider: input.provider ?? "self",
            proof_type: "unique_human",
            mechanism: "session_complete",
            verified_at: input.verifiedAt,
          },
        }) }] }
      }
      return { rows: [{ mechanism: "zk-nullifier", nullifier_hash: input.nullifier ?? "human-1" }] }
    },
  }
}

describe("reward identity resolution", () => {
  test("derives a stable opaque identity from the configured provider nullifier", async () => {
    const verifiedAt = Math.floor(Date.now() / 1000)
    const firstClient = client({ verifiedAt })
    const secondClient = client({ verifiedAt })
    const first = await resolveActiveRewardIdentity(firstClient, "usr_1", "self")
    const second = await resolveActiveRewardIdentity(secondClient, "usr_2", "self")
    expect(first).toEqual(second)
    expect(first?.id).toMatch(/^rwi_[a-f0-9]{64}$/)
    expect(firstClient.calls).toBe(2)
  })

  test("rejects expired or wrong-provider capabilities before reading a nullifier", async () => {
    const expired = client({ verifiedAt: Math.floor(Date.now() / 1000) - 91 * 86_400 })
    expect(await resolveActiveRewardIdentity(expired, "usr_1", "self")).toBeNull()
    expect(expired.calls).toBe(1)
    const wrongProvider = client({ verifiedAt: Math.floor(Date.now() / 1000), provider: "very" })
    expect(await resolveActiveRewardIdentity(wrongProvider, "usr_1", "self")).toBeNull()
    expect(wrongProvider.calls).toBe(1)
  })

  test("selects the first live supported identity by fixed provider precedence", async () => {
    const now = Date.parse("2026-08-05T12:00:00.000Z")
    const multiProviderClient = {
      async execute(statement: InStatement | string): Promise<QueryResult> {
        const sql = typeof statement === "string" ? statement : statement.sql
        if (sql.includes("FROM users")) return { rows: [{ verification_capabilities_json: null }] }
        return { rows: [
          {
            provider: "self",
            mechanism: "zk-nullifier",
            nullifier_hash: "expired-self",
            source_user_attestation_id: "att_self",
            attestation_status: "accepted",
            attestation_verified_at: "2026-04-01T00:00:00.000Z",
            attestation_expires_at: null,
          },
          {
            provider: "zkpassport",
            mechanism: "zkpassport-unique-identifier",
            nullifier_hash: "live-zkpassport",
            source_user_attestation_id: "att_zkp",
            attestation_status: "accepted",
            attestation_verified_at: "2026-08-01T00:00:00.000Z",
            attestation_expires_at: "2026-09-01T00:00:00.000Z",
          },
          {
            provider: "very",
            mechanism: "palm-nullifier",
            nullifier_hash: "live-very",
            source_user_attestation_id: "att_very",
            attestation_status: "accepted",
            attestation_verified_at: "2026-08-02T00:00:00.000Z",
            attestation_expires_at: null,
          },
        ] }
      },
    }
    const identity = await resolveActiveSupportedRewardIdentity(multiProviderClient, "usr_1", now)
    expect(identity?.provider).toBe("zkpassport")
  })

  test("rejects every supported identity when each candidate is expired or revoked", async () => {
    const expiredClient = {
      async execute(statement: InStatement | string): Promise<QueryResult> {
        const sql = typeof statement === "string" ? statement : statement.sql
        if (sql.includes("FROM users")) return { rows: [{ verification_capabilities_json: null }] }
        return { rows: [
          {
            provider: "self", mechanism: "zk-nullifier", nullifier_hash: "one",
            source_user_attestation_id: "att_1", attestation_status: "accepted",
            attestation_verified_at: "2026-04-01T00:00:00.000Z", attestation_expires_at: null,
          },
          {
            provider: "very", mechanism: "palm-nullifier", nullifier_hash: "two",
            source_user_attestation_id: "att_2", attestation_status: "revoked",
            attestation_verified_at: "2026-08-01T00:00:00.000Z", attestation_expires_at: null,
          },
        ] }
      },
    }
    expect(await resolveActiveSupportedRewardIdentity(
      expiredClient,
      "usr_1",
      Date.parse("2026-08-05T12:00:00.000Z"),
    )).toBeNull()
  })
})
