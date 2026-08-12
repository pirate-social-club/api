import { describe, expect, test } from "bun:test"
import { buildHnsZoneControlPlaneInventory } from "./admin-hns-zone-inventory"

describe("HNS zone control-plane inventory", () => {
  test("protects attached, pending, delegated, and hard-denied roots", () => {
    const inventory = buildHnsZoneControlPlaneInventory([
      {
        normalized_root_label: "attached",
        active_attachment_count: 1,
        active_verification_count: 1,
        pending_session_count: 0,
        delegation_state_present: 0,
        canonical_routing_eligible: 0,
        routing_hard_denied: 0,
        challenge_txt_values: ["old"],
        active_challenge_txt_values: [],
        last_activity_at: "2026-08-12T00:00:00.000Z",
      },
      {
        normalized_root_label: "pending",
        active_attachment_count: 0,
        active_verification_count: 0,
        pending_session_count: 1,
        delegation_state_present: 0,
        canonical_routing_eligible: 0,
        routing_hard_denied: 0,
        challenge_txt_values: ["new"],
        active_challenge_txt_values: ["new"],
        last_activity_at: null,
      },
      {
        normalized_root_label: "delegated",
        active_attachment_count: 0,
        active_verification_count: 0,
        pending_session_count: 0,
        delegation_state_present: 1,
        canonical_routing_eligible: 0,
        routing_hard_denied: 0,
        challenge_txt_values: [],
        active_challenge_txt_values: [],
        last_activity_at: null,
      },
      {
        normalized_root_label: "denied",
        active_attachment_count: 0,
        active_verification_count: 0,
        pending_session_count: 0,
        delegation_state_present: 0,
        canonical_routing_eligible: 0,
        routing_hard_denied: 1,
        challenge_txt_values: [],
        active_challenge_txt_values: [],
        last_activity_at: null,
      },
    ])

    expect(inventory.roots).toHaveLength(4)
    expect(inventory.roots.every((root) => root.protected)).toBe(true)
  })

  test("keeps an unreferenced root reviewable rather than silently protected", () => {
    const inventory = buildHnsZoneControlPlaneInventory([{
      normalized_root_label: "tame_impala",
      active_attachment_count: 0,
      active_verification_count: 0,
      pending_session_count: 0,
      delegation_state_present: 0,
      canonical_routing_eligible: 0,
      routing_hard_denied: 0,
      challenge_txt_values: ["pirate-verification=stale"],
      active_challenge_txt_values: [],
      last_activity_at: "2026-06-01T00:00:00.000Z",
    }], "2026-08-12T12:00:00.000Z")

    expect(inventory.roots[0]).toMatchObject({
      normalized_root_label: "tame_impala",
      protected: false,
      challenge_txt_values: ["pirate-verification=stale"],
    })
  })
})
