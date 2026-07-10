import { describe, expect, test } from "bun:test"
import { resolveActiveRewardIdentity } from "./unique-human-eligibility"
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
})
