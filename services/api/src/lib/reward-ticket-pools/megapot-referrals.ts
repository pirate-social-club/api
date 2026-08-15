import { getAddress } from "ethers"

export const MEGAPOT_REFERRAL_WEIGHT_SCALE = 10n ** 18n

export type MegapotReferralScheme = Readonly<{
  referrers: readonly string[]
  referralSplitWeights: readonly bigint[]
}>

export function assertMegapotReferralScheme(scheme: MegapotReferralScheme): void {
  if (scheme.referrers.length === 0 || scheme.referrers.length !== scheme.referralSplitWeights.length) {
    throw new Error("Megapot referral scheme lengths are invalid")
  }
  const normalized = scheme.referrers.map((address) => getAddress(address).toLowerCase())
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Megapot referral addresses must be unique")
  }
  if (scheme.referralSplitWeights.some((weight) => weight <= 0n)) {
    throw new Error("Megapot referral weights must be positive")
  }
  const sum = scheme.referralSplitWeights.reduce((total, weight) => total + weight, 0n)
  if (sum !== MEGAPOT_REFERRAL_WEIGHT_SCALE) {
    throw new Error("Megapot referral weights must sum to exactly 1e18")
  }
}

export function platformMegapotReferralScheme(platformRevenueAddress: string): MegapotReferralScheme {
  const scheme = {
    referrers: [getAddress(platformRevenueAddress)],
    referralSplitWeights: [MEGAPOT_REFERRAL_WEIGHT_SCALE],
  }
  assertMegapotReferralScheme(scheme)
  return scheme
}

export type RewardTicketRevenueEntry = Readonly<{
  ledger: "beneficiary_claim_proceeds" | "platform_referral_revenue"
  amountAtomic: bigint
  recipientAddress: string
}>

export function assertSegregatedRewardTicketRevenue(input: {
  beneficiaryProceeds: RewardTicketRevenueEntry
  platformReferralRevenue: RewardTicketRevenueEntry
}): void {
  if (
    input.beneficiaryProceeds.ledger !== "beneficiary_claim_proceeds"
    || input.platformReferralRevenue.ledger !== "platform_referral_revenue"
    || input.beneficiaryProceeds.amountAtomic < 0n
    || input.platformReferralRevenue.amountAtomic < 0n
    || getAddress(input.beneficiaryProceeds.recipientAddress)
      === getAddress(input.platformReferralRevenue.recipientAddress)
  ) {
    throw new Error("Megapot beneficiary proceeds and platform referral revenue must remain segregated")
  }
}
