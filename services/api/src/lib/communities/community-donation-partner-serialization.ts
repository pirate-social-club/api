import type { CommunityPreview } from "../../types"

export type SerializedDonationPartner = Omit<
  NonNullable<CommunityPreview["donation_partner"]>,
  "provider_partner_ref" | "image_url"
> & {
  provider_partner_ref: string | null
  payout_destination_ref: string | null
  image_url: string | null
}

export function serializeDonationPartnerRow(row: Record<string, unknown>): SerializedDonationPartner {
  return {
    donation_partner_id: String(row.donation_partner_id),
    display_name: String(row.display_name),
    provider: row.provider === "endaoment" ? "endaoment" : "endaoment",
    provider_partner_ref: row.provider_partner_ref == null ? null : String(row.provider_partner_ref),
    payout_destination_ref:
      row.payout_destination_ref == null ? null : String(row.payout_destination_ref),
    image_url: row.image_url == null ? null : String(row.image_url),
    review_status:
      row.review_status === "pending" || row.review_status === "rejected"
        ? row.review_status
        : "approved",
    status:
      row.status === "paused" || row.status === "retired"
        ? row.status
        : "active",
  }
}
