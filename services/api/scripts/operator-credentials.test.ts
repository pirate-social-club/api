import { describe, expect, test } from "bun:test"

import {
  ALLOWED_SCOPES,
  BOOKING_SETTLEMENT_RESOLVE_SCOPE,
  credentialEnvNameForScopes,
  normalizeOperatorDatabaseUrl,
  REWARD_CAMPAIGN_INCIDENT_RESOLVE_SCOPE,
  STORY_SETTLEMENT_REPAIR_SCOPE,
} from "./operator-credentials"

describe("operator credential issuance config", () => {
  test("accepts the reward recovery scope and selects a reward-specific secret name", () => {
    expect(ALLOWED_SCOPES.has(REWARD_CAMPAIGN_INCIDENT_RESOLVE_SCOPE)).toBe(true)
    expect(credentialEnvNameForScopes([REWARD_CAMPAIGN_INCIDENT_RESOLVE_SCOPE]))
      .toBe("PIRATE_REWARD_CAMPAIGN_OPERATOR_CREDENTIAL")
  })

  test("preserves the bookings credential secret name", () => {
    expect(credentialEnvNameForScopes([BOOKING_SETTLEMENT_RESOLVE_SCOPE]))
      .toBe("PIRATE_BOOKING_SETTLEMENT_OPERATOR_CREDENTIAL")
  })

  test("uses a dedicated Story settlement repair credential", () => {
    expect(ALLOWED_SCOPES.has(STORY_SETTLEMENT_REPAIR_SCOPE)).toBe(true)
    expect(credentialEnvNameForScopes([STORY_SETTLEMENT_REPAIR_SCOPE]))
      .toBe("PIRATE_STORY_SETTLEMENT_OPERATOR_CREDENTIAL")
  })

  test("requires an explicit, valid name for a multi-scope credential", () => {
    expect(() => credentialEnvNameForScopes([
      BOOKING_SETTLEMENT_RESOLVE_SCOPE,
      REWARD_CAMPAIGN_INCIDENT_RESOLVE_SCOPE,
    ])).toThrow("multi-scope")
    expect(() => credentialEnvNameForScopes(
      [REWARD_CAMPAIGN_INCIDENT_RESOLVE_SCOPE],
      "not-valid",
    )).toThrow("uppercase")
    expect(credentialEnvNameForScopes(
      [BOOKING_SETTLEMENT_RESOLVE_SCOPE, REWARD_CAMPAIGN_INCIDENT_RESOLVE_SCOPE],
      "PIRATE_COMBINED_OPERATOR_CREDENTIAL",
    )).toBe("PIRATE_COMBINED_OPERATOR_CREDENTIAL")
  })

  test("removes Bun-incompatible sslrootcert without changing other connection options", () => {
    expect(normalizeOperatorDatabaseUrl(
      "postgresql://operator:secret@example.pg.psdb.cloud/pirate?sslmode=require&sslrootcert=%2Fetc%2Fssl%2Fca.pem&application_name=ops",
    )).toBe(
      "postgresql://operator:secret@example.pg.psdb.cloud/pirate?sslmode=require&application_name=ops",
    )
  })
})
