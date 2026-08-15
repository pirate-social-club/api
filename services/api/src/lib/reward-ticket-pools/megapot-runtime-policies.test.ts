import { describe, expect, test } from "bun:test"
import { Interface } from "ethers"

import { MEGAPOT_CLAIM_ERRORS_ABI } from "./megapot-abi"
import {
  isMegapotNoTicketsToClaim,
  isPayingMegapotTier,
  payingMegapotTicketIds,
} from "./megapot-claim-policy"
import { decideMegapotPurchaseRetry } from "./megapot-purchase-retry"
import {
  MEGAPOT_REFERRAL_WEIGHT_SCALE,
  assertMegapotReferralScheme,
  assertSegregatedRewardTicketRevenue,
  platformMegapotReferralScheme,
} from "./megapot-referrals"
import {
  assertRewardTicketBackingDomainActive,
  classifyRewardTicketLedgerWriteError,
} from "./reward-ticket-cashout-policy"

describe("Megapot claim and referral policies", () => {
  test("uses the protocol paying-tier predicate and treats NoTicketsToClaim as state", () => {
    expect([0, 1, 2, 3].map(isPayingMegapotTier)).toEqual([false, true, false, true])
    expect(payingMegapotTicketIds([
      { ticketId: 10n, tierId: 2 },
      { ticketId: 11n, tierId: 3 },
    ])).toEqual([11n])

    const errorData = new Interface(MEGAPOT_CLAIM_ERRORS_ABI).encodeErrorResult("NoTicketsToClaim")
    expect(isMegapotNoTicketsToClaim({ error: { data: errorData } })).toBe(true)
    expect(isMegapotNoTicketsToClaim(new Error("NoTicketsToClaim"))).toBe(false)
  })

  test("uses 1e18 weights and routes referral revenue to its separate address", () => {
    const scheme = platformMegapotReferralScheme("0x3000000000000000000000000000000000000003")
    expect(scheme.referralSplitWeights).toEqual([MEGAPOT_REFERRAL_WEIGHT_SCALE])
    expect(() => assertMegapotReferralScheme({
      referrers: scheme.referrers,
      referralSplitWeights: [10_000n],
    })).toThrow("exactly 1e18")
    expect(() => assertSegregatedRewardTicketRevenue({
      beneficiaryProceeds: {
        ledger: "beneficiary_claim_proceeds",
        amountAtomic: 10n,
        recipientAddress: "0x1000000000000000000000000000000000000001",
      },
      platformReferralRevenue: {
        ledger: "platform_referral_revenue",
        amountAtomic: 1n,
        recipientAddress: "0x1000000000000000000000000000000000000001",
      },
    })).toThrow("must remain segregated")
  })
})

describe("Megapot retry and cashout policies", () => {
  test("only permits same-nonce replacement after reconcile-before-retry", () => {
    expect(decideMegapotPurchaseRetry({
      durableNonce: 12,
      transaction: "absent",
      latestNonce: 12,
      pendingNonce: 12,
    })).toEqual({ disposition: "replace_same_nonce", nonce: 12 })
    expect(decideMegapotPurchaseRetry({
      durableNonce: 12,
      transaction: "absent",
      latestNonce: 13,
      pendingNonce: 13,
    })).toEqual({ disposition: "needs_review", reason: "nonce_already_consumed" })
    expect(decideMegapotPurchaseRetry({
      durableNonce: 12,
      transaction: "pending",
      latestNonce: 12,
      pendingNonce: 13,
    })).toEqual({ disposition: "wait" })
  })

  test("blocks inactive backing domains and classifies ledger SQLSTATEs fail closed", () => {
    expect(() => assertRewardTicketBackingDomainActive("operational_hold"))
      .toThrow("reward_ticket_backing_domain_not_active")
    expect(classifyRewardTicketLedgerWriteError({ errno: "23514" })).toEqual({
      disposition: "fail_closed",
      retryable: false,
      sqlState: "23514",
    })
    expect(classifyRewardTicketLedgerWriteError({ code: "23505" })).toEqual({
      disposition: "reconcile_as_applied",
      retryable: false,
      sqlState: "23505",
    })
    expect(classifyRewardTicketLedgerWriteError({ sqlState: "23503" })).toEqual({
      disposition: "fail_closed",
      retryable: false,
      sqlState: "23503",
    })
    expect(classifyRewardTicketLedgerWriteError({ code: "42P01" })).toEqual({
      disposition: "fail_closed",
      retryable: false,
      sqlState: "42P01",
    })
    for (const transientState of ["40001", "40P01", "08006", "57P01"]) {
      expect(classifyRewardTicketLedgerWriteError({ code: transientState })).toEqual({
        disposition: "retry_later",
        retryable: true,
        sqlState: transientState,
      })
    }
    expect(classifyRewardTicketLedgerWriteError(new Error("network"))).toEqual({
      disposition: "retry_later",
      retryable: true,
      sqlState: null,
    })
  })
})
