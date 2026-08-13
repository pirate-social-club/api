import { describe, expect, test } from "bun:test"

import {
  handleClaimIntentsEnabled,
  handleClaimRefundsEnabled,
} from "./handle-claim-intent-config"

describe("handle claim recovery flags", () => {
  test("keeps refund recovery available when new admissions are disabled", () => {
    const env = {
      COMMUNITY_HANDLE_CLAIM_INTENTS_ENABLED: "false",
      COMMUNITY_HANDLE_CLAIM_REFUNDS_ENABLED: "true",
    }

    expect(handleClaimIntentsEnabled(env as never)).toBe(false)
    expect(handleClaimRefundsEnabled(env as never)).toBe(true)
  })

  test("does not run refund recovery when its own flag is disabled", () => {
    const env = {
      COMMUNITY_HANDLE_CLAIM_INTENTS_ENABLED: "true",
      COMMUNITY_HANDLE_CLAIM_REFUNDS_ENABLED: "false",
    }

    expect(handleClaimRefundsEnabled(env as never)).toBe(false)
  })
})
