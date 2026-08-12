import { describe, expect, test } from "bun:test"
import {
  serializeDonationPartnerRow,
  serializeLocalDonationPartnerRow,
} from "./community-donation-partner-serialization"

const row = {
  donation_partner_id: "partner_test",
  display_name: "Test Partner",
  provider: "endaoment",
  provider_partner_ref: "provider_ref",
  payout_destination_ref: "sensitive_destination",
  image_url: null,
  review_status: "approved",
  status: "active",
}

describe("donation partner serialization", () => {
  test("omits settlement destinations from public responses", () => {
    expect(serializeDonationPartnerRow(row)).not.toHaveProperty("payout_destination_ref")
  })

  test("retains settlement destinations in the internal local row", () => {
    expect(serializeLocalDonationPartnerRow(row).payout_destination_ref).toBe("sensitive_destination")
  })
})
