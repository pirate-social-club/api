import { describe, expect, test } from "bun:test"
import type { InStatement } from "../sql-client"
import {
  evaluateIdentityEvidenceAtom,
  type IdentityEvidence,
} from "./provider-keyed-identity-evidence"

function evidence(overrides: Partial<IdentityEvidence> = {}): IdentityEvidence {
  return {
    evidenceId: "att_1",
    userId: "user_1",
    capability: "nationality",
    provider: "self",
    mechanism: "zk-nullifier",
    value: { nationality: "USA" },
    verifiedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    sourceVerificationSessionId: "session_1",
    sourceIdentityNullifierId: "nullifier_1",
    ...overrides,
  }
}

describe("provider-keyed identity evidence evaluator", () => {
  test("uses any-match across providers without combining values", () => {
    const result = evaluateIdentityEvidenceAtom({
      evidence: [
        evidence({ provider: "self", value: { nationality: "CAN" } }),
        evidence({ evidenceId: "att_2", provider: "zkpassport", value: { nationality: "USA" } }),
      ],
      atom: { capability: "nationality", acceptedProviders: ["self", "zkpassport"], requiredCountries: ["US"] },
    })

    expect(result.outcome).toBe("passed")
    expect(result.witnesses.map((witness) => witness.evidenceId)).toEqual(["att_2"])
  })

  test("normalizes alpha-2 and alpha-3 country codes", () => {
    const result = evaluateIdentityEvidenceAtom({
      evidence: [evidence({ value: { nationality: "US" } })],
      atom: { capability: "nationality", acceptedProviders: ["self"], requiredCountries: ["USA"] },
    })
    expect(result.outcome).toBe("passed")
  })

  test("keeps two same-provider documents as independent any-match witnesses", () => {
    const result = evaluateIdentityEvidenceAtom({
      evidence: [
        evidence({ value: { nationality: "CAN" }, sourceIdentityNullifierId: "nullifier_a" }),
        evidence({ evidenceId: "att_2", value: { nationality: "USA" }, sourceIdentityNullifierId: "nullifier_b" }),
      ],
      atom: { capability: "nationality", acceptedProviders: ["self"], requiredCountries: ["US"] },
    })
    expect(result.outcome).toBe("passed")
    expect(result.witnesses.map((witness) => witness.sourceIdentityNullifierId)).toEqual(["nullifier_b"])
  })

  test("reader keeps expiry in SQL and requires active nullifiers only where needed", async () => {
    let statement: InStatement | string | null = null
    const rows = [
      {
        user_attestation_id: "att_human",
        user_id: "user_1",
        source_verification_session_id: "session_1",
        source_identity_nullifier_id: null,
        provider: "self",
        attestation_type: "unique_human",
        capability_key: "unique_human",
        value_json: JSON.stringify({ state: "verified" }),
        verified_at: "2026-01-01T00:00:00.000Z",
        expires_at: null,
        active_nullifier_id: "nullifier_1",
        nullifier_mechanism: "zk-nullifier",
      },
      {
        user_attestation_id: "att_nationality",
        user_id: "user_1",
        source_verification_session_id: "session_1",
        source_identity_nullifier_id: "nullifier_1",
        provider: "self",
        attestation_type: "nationality",
        capability_key: "nationality",
        value_json: JSON.stringify({ nationality: "USA" }),
        verified_at: "2026-01-01T00:00:00.000Z",
        expires_at: null,
        active_nullifier_id: "nullifier_1",
        nullifier_mechanism: "zk-nullifier",
      },
      {
        user_attestation_id: "att_gender",
        user_id: "user_1",
        source_verification_session_id: "session_1",
        source_identity_nullifier_id: "nullifier_gender",
        provider: "self",
        attestation_type: "gender",
        capability_key: "gender",
        value_json: JSON.stringify({ gender: "F" }),
        verified_at: "2026-01-01T00:00:00.000Z",
        expires_at: null,
        active_nullifier_id: null,
        nullifier_mechanism: null,
      },
    ]
    const { readActiveIdentityEvidence } = await import("./provider-keyed-identity-evidence")
    const result = await readActiveIdentityEvidence({
      client: { execute: async (input) => { statement = input; return { rows } } },
      userId: "user_1",
      now: new Date("2026-01-02T00:00:00.000Z"),
    })
    expect(typeof statement === "string" ? statement : statement?.sql).toContain("a.expires_at > ?2")
    expect(result.map((item) => item.capability)).toEqual(["unique_human", "nationality", "gender"])
    expect(result[0]?.sourceIdentityNullifierId).toBe("nullifier_1")
    expect(result[2]?.sourceIdentityNullifierId).toBe("nullifier_gender")
  })

  test("matches minimum age and gender inside the shared evaluator", () => {
    expect(evaluateIdentityEvidenceAtom({
      evidence: [evidence({ capability: "minimum_age", value: { minimum_age: 21 }, sourceIdentityNullifierId: null })],
      atom: { capability: "minimum_age", acceptedProviders: ["self"], minimumAge: 18 },
    }).outcome).toBe("passed")
    expect(evaluateIdentityEvidenceAtom({
      evidence: [evidence({ capability: "gender", value: { gender: "F" }, sourceIdentityNullifierId: null })],
      atom: { capability: "gender", acceptedProviders: ["self"], requiredGender: "M" },
    }).mismatchReasons).toEqual(["gender_mismatch"])
  })
})
