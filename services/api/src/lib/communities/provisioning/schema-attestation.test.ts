import { describe, expect, test } from "bun:test"
import { provisioningSchemaAttestation } from "./schema-attestation"

describe("provisioningSchemaAttestation", () => {
  test("returns generated proof only for an exact SHA-256 policy digest", () => {
    const digest = "a".repeat(64)
    expect(provisioningSchemaAttestation({ COMMUNITY_SCHEMA_POLICY_DIGEST: digest })).toMatchObject({
      effectivePolicyDigest: digest,
      expectedObservationProof: { format_version: 1, kind: "raw" },
    })
  })

  test("omits optional evidence when release policy is absent or malformed", () => {
    expect(provisioningSchemaAttestation({})).toBeUndefined()
    expect(
      provisioningSchemaAttestation({
        COMMUNITY_SCHEMA_POLICY_DIGEST: "not-a-digest",
      }),
    ).toBeUndefined()
  })
})
