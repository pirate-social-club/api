import { describe, expect, test } from "bun:test"

import {
  ALLOWED_SCOPES,
  BOOKING_SETTLEMENT_RESOLVE_SCOPE,
  credentialEnvNameForScopes,
  REWARD_CAMPAIGN_INCIDENT_RESOLVE_SCOPE,
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
})
