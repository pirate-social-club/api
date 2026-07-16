import { describe, expect, test } from "bun:test"

import { classifyStorySettlementCoordinatorHealth } from "./story-settlement-coordinator-watchdog"
import type { StorySettlementCoordinatorHealth } from "./story-settlement-wallet-coordinator-do"

const healthy: StorySettlementCoordinatorHealth = {
  chainId: 1315,
  signerAddress: "0x1111111111111111111111111111111111111111",
  pendingPlans: 1,
  oldestBacklogAgeMs: 1_000,
  reconciliationRequiredSteps: 0,
  oldestReconciliationAgeMs: 0,
  replacedSteps: 0,
  latestNonce: 7,
  pendingNonce: 7,
  nextAllocatedNonce: 7,
  nonceGap: false,
  nativeBalanceWei: "1000",
  nativeRequiredWei: "900",
  wipBalanceWei: "500",
  wipObligationWei: "500",
  surplusWipWei: "0",
}

describe("classifyStorySettlementCoordinatorHealth", () => {
  test("returns no alert for healthy coordinator evidence", () => {
    expect(classifyStorySettlementCoordinatorHealth(healthy, { backlogMs: 10_000, reconciliationMs: 5_000 })).toEqual([])
  })

  test("classifies every money-path gate signal", () => {
    const alerts = classifyStorySettlementCoordinatorHealth({
      ...healthy,
      oldestBacklogAgeMs: 10_000,
      reconciliationRequiredSteps: 1,
      oldestReconciliationAgeMs: 5_000,
      replacedSteps: 2,
      nonceGap: true,
      nativeBalanceWei: "899",
      wipBalanceWei: "499",
      surplusWipWei: "1",
    }, { backlogMs: 10_000, reconciliationMs: 5_000 })
    expect(alerts.map((alert) => alert.key)).toEqual([
      "backlog_age",
      "nonce_gap",
      "replaced_steps",
      "reconciliation_age",
      "native_insolvency",
      "wip_insolvency",
      "surplus_wip",
    ])
  })
})
