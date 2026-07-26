import { describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import { HttpError } from "../errors"
import type { Client } from "../sql-client"
import {
  assertRewardSolvencyAdmission,
  getRewardSolvencyGateStatus,
} from "./reward-solvency-gate"

function clientWithObservation(row?: Record<string, unknown>): Client {
  return {
    execute: async () => ({ rows: row ? [row] : [] }),
  } as unknown as Client
}

const enabledEnv = {
  REWARDS_SOLVENCY_FREEZE_ENABLED: "true",
  REWARDS_SOLVENCY_MAX_OBSERVATION_AGE_SECONDS: "300",
} as Env

describe("reward solvency admission gate", () => {
  test("is dark by default", async () => {
    const status = await getRewardSolvencyGateStatus({
      env: {} as Env,
      client: clientWithObservation(),
    })
    expect(status).toMatchObject({ enabled: false, admitting: true, reason: "disabled" })
  })

  test("fails closed when no observation exists", async () => {
    const status = await getRewardSolvencyGateStatus({
      env: enabledEnv,
      client: clientWithObservation(),
    })
    expect(status).toMatchObject({
      enabled: true,
      admitting: false,
      reason: "unknown_observation",
    })
  })

  test("distinguishes stale observations from insufficient float", async () => {
    const now = new Date("2026-07-26T12:10:00.000Z")
    const stale = await getRewardSolvencyGateStatus({
      env: enabledEnv,
      client: clientWithObservation({
        balance_atomic: "2000000",
        total_liability_atomic: "1000000",
        solvent: true,
        observed_at: "2026-07-26T12:00:00.000Z",
      }),
      now,
    })
    expect(stale).toMatchObject({ admitting: false, reason: "stale_observation", ageSeconds: 600 })

    const insolvent = await getRewardSolvencyGateStatus({
      env: enabledEnv,
      client: clientWithObservation({
        balance_atomic: "500000",
        total_liability_atomic: "1000000",
        solvent: false,
        observed_at: "2026-07-26T12:09:00.000Z",
      }),
      now,
    })
    expect(insolvent).toMatchObject({ admitting: false, reason: "insufficient_float", ageSeconds: 60 })
  })

  test("admits only a fresh solvent observation and reports a retryable freeze", async () => {
    const now = new Date("2026-07-26T12:10:00.000Z")
    const client = clientWithObservation({
      balance_atomic: "2000000",
      total_liability_atomic: "1000000",
      solvent: true,
      observed_at: "2026-07-26T12:09:00.000Z",
    })
    await expect(assertRewardSolvencyAdmission({ env: enabledEnv, client, now })).resolves.toBeUndefined()

    try {
      await assertRewardSolvencyAdmission({
        env: enabledEnv,
        client: clientWithObservation(),
        now,
      })
      throw new Error("expected freeze")
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError)
      expect(error).toMatchObject({
        code: "provider_unavailable",
        retryable: true,
        details: { reason: "unknown_observation" },
      })
    }
  })
})
