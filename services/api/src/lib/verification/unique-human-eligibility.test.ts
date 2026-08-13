import { describe, expect, test } from "bun:test"
import { resolveActiveRewardIdentity, resolveActiveSupportedRewardIdentity } from "./unique-human-eligibility"
import type { InStatement, QueryResult } from "../sql-client"

function evidenceRow(input: {
  provider: string
  attestationId: string
  verifiedAt: string
  expiresAt: string | null
}) {
  return {
    user_attestation_id: input.attestationId,
    user_id: "usr_1",
    source_verification_session_id: "ver_1",
    source_identity_nullifier_id: null,
    provider: input.provider,
    attestation_type: "unique_human",
    capability_key: "unique_human",
    value_json: JSON.stringify({ state: "verified" }),
    verified_at: input.verifiedAt,
    expires_at: input.expiresAt,
    active_nullifier_id: `${input.provider}-nullifier-id`,
    nullifier_mechanism: input.provider === "very" ? "palm-nullifier" : "zk-nullifier",
  }
}

function client(input: {
  verifiedAt: number
  provider?: string
  nullifier?: string
  expiresAt?: string | null
}) {
  let calls = 0
  const provider = input.provider ?? "self"
  return {
    get calls() { return calls },
    async execute(statement: InStatement | string): Promise<QueryResult> {
      calls += 1
      const sql = typeof statement === "string" ? statement : statement.sql
      if (sql.includes("FROM user_attestations a")) {
        if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) return { rows: [] }
        return { rows: [evidenceRow({
          provider,
          attestationId: "att_human",
          verifiedAt: new Date(input.verifiedAt).toISOString(),
          expiresAt: input.expiresAt ?? null,
        })] }
      }
      if (sql.includes("FROM users")) return { rows: [{ verification_capabilities_json: null }] }
      return {
        rows: [{
          identity_nullifier_id: `${provider}-nullifier-id`,
          mechanism: provider === "very" ? "palm-nullifier" : "zk-nullifier",
          nullifier_hash: input.nullifier ?? "human-1",
        }],
      }
    },
  }
}

describe("reward identity resolution", () => {
  test("derives a stable opaque identity from the configured provider nullifier", async () => {
    const verifiedAt = Date.now()
    const firstClient = client({ verifiedAt })
    const secondClient = client({ verifiedAt })
    const first = await resolveActiveRewardIdentity(firstClient, "usr_1", "self")
    const second = await resolveActiveRewardIdentity(secondClient, "usr_2", "self")
    expect(first).toEqual(second)
    expect(first?.id).toMatch(/^rwi_[a-f0-9]{64}$/)
    expect(firstClient.calls).toBe(2)
  })

  test("rejects expired or wrong-provider capabilities before reading a nullifier", async () => {
    const expiredAt = new Date(Date.now() - 91 * 86_400 * 1_000).toISOString()
    const expired = client({ verifiedAt: Date.parse(expiredAt), expiresAt: expiredAt })
    expect(await resolveActiveRewardIdentity(expired, "usr_1", "self")).toBeNull()
    expect(expired.calls).toBe(1)
    const wrongProvider = client({ verifiedAt: Date.now(), provider: "very" })
    expect(await resolveActiveRewardIdentity(wrongProvider, "usr_1", "self")).toBeNull()
    expect(wrongProvider.calls).toBe(1)
  })

  test("selects the first live supported identity by fixed provider precedence", async () => {
    const now = Date.parse("2026-08-05T12:00:00.000Z")
    const multiProviderClient = {
      async execute(statement: InStatement | string): Promise<QueryResult> {
        const sql = typeof statement === "string" ? statement : statement.sql
        if (sql.includes("FROM users")) return { rows: [{ verification_capabilities_json: null }] }
        if (sql.includes("FROM user_attestations a")) return { rows: [
          evidenceRow({ provider: "zkpassport", attestationId: "att_zkp", verifiedAt: "2026-08-01T00:00:00.000Z", expiresAt: "2026-09-01T00:00:00.000Z" }),
          evidenceRow({ provider: "very", attestationId: "att_very", verifiedAt: "2026-08-02T00:00:00.000Z", expiresAt: null }),
        ] }
        return { rows: [
          {
            identity_nullifier_id: "zkpassport-nullifier-id",
            provider: "zkpassport",
            mechanism: "zkpassport-unique-identifier",
            nullifier_hash: "live-zkpassport",
            source_user_attestation_id: "att_zkp",
          },
          {
            identity_nullifier_id: "very-nullifier-id",
            provider: "very",
            mechanism: "palm-nullifier",
            nullifier_hash: "live-very",
            source_user_attestation_id: "att_very",
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
        if (sql.includes("FROM user_attestations a")) return { rows: [] }
        return { rows: [{
          identity_nullifier_id: "very-nullifier-id",
          provider: "very",
          mechanism: "palm-nullifier",
          nullifier_hash: "two",
          source_user_attestation_id: "att_2",
        }] }
      },
    }
    expect(await resolveActiveSupportedRewardIdentity(
      expiredClient,
      "usr_1",
      Date.parse("2026-08-05T12:00:00.000Z"),
    )).toBeNull()
  })
})
