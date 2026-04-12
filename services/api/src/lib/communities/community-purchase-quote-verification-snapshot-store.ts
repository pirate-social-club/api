import type { Client } from "@libsql/client"

export async function insertCommunityPurchaseQuoteVerificationSnapshot(input: {
  client: Client
  verificationSnapshotRef: string
  communityId: string
  quoteId: string
  buyerUserId: string
  provider: string | null
  nationalityState: string
  nationalityValue: string | null
  pricingTier: string | null
  pricingPolicyVersion: string
  snapshotJson: string
  createdAt: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      INSERT INTO purchase_quote_verification_snapshots (
        verification_snapshot_ref,
        community_id,
        quote_id,
        buyer_user_id,
        provider,
        nationality_state,
        nationality_value,
        pricing_tier,
        pricing_policy_version,
        snapshot_json,
        created_at,
        updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11
      )
    `,
    args: [
      input.verificationSnapshotRef,
      input.communityId,
      input.quoteId,
      input.buyerUserId,
      input.provider,
      input.nationalityState,
      input.nationalityValue,
      input.pricingTier,
      input.pricingPolicyVersion,
      input.snapshotJson,
      input.createdAt,
    ],
  })
}
