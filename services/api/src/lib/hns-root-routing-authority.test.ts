import { describe, expect, test } from "bun:test"

import {
  HNS_ROOT_ROUTING_AUTHORITY_TTL_MS,
  readHnsRootRoutingAuthority,
} from "./hns-root-routing-authority"

const NOW = new Date("2026-08-11T00:00:00.000Z")

function activeDelegationRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    delegation_root_label: "dankmeme",
    delegation_rollover_state: "none",
    delegation_pending_evidence_kind: null,
    delegation_authority_redundancy_ok: 1,
    delegation_authority_redundancy_evidence_class: "external_multi_vantage",
    delegation_redundancy_observed_at: "2026-08-10T23:59:00.000Z",
    delegation_canonical_routing_eligible: 1,
    delegation_routing_hard_denied: 0,
    delegation_last_parent_observation_id: "obs_1",
    delegation_parent_observation_id: "obs_1",
    delegation_security: "secure",
    delegation_parent_ds_matches_live_dnskey: 1,
    delegation_authoritative_dnssec_valid: 1,
    delegation_observed_at: "2026-08-10T23:59:00.000Z",
    delegation_earliest_rrsig_expires_at: "2026-08-11T02:00:00.000Z",
    ...overrides,
  }
}

function clientReturning(row: Record<string, unknown> | null) {
  return {
    execute: async () => ({ rows: row ? [row] : [] }),
  }
}

describe("HNS root routing authority", () => {
  test("uses the delegation read model for an activated root", async () => {
    const result = await readHnsRootRoutingAuthority(
      clientReturning(activeDelegationRow()),
      "dankmeme",
      NOW,
    )

    expect(result).toEqual({ effective: true, reasonCode: "enabled" })
  })

  test("fails closed for non-activated and hard-denied roots", async () => {
    await expect(readHnsRootRoutingAuthority(
      clientReturning(activeDelegationRow({ delegation_canonical_routing_eligible: 0 })),
      "dankmeme",
      NOW,
    )).resolves.toEqual({ effective: false, reasonCode: "not_activated" })

    await expect(readHnsRootRoutingAuthority(
      clientReturning(activeDelegationRow({ delegation_routing_hard_denied: 1 })),
      "dankmeme",
      NOW,
    )).resolves.toEqual({ effective: false, reasonCode: "hard_denied" })

    await expect(readHnsRootRoutingAuthority(
      clientReturning({}),
      "dankmeme",
      NOW,
    )).resolves.toEqual({ effective: false, reasonCode: "not_found" })
  })

  test("fails closed for unknown roots and documents the revocation TTL", async () => {
    await expect(readHnsRootRoutingAuthority(
      clientReturning(null),
      "unknown-root",
      NOW,
    )).resolves.toEqual({ effective: false, reasonCode: "not_found" })
    expect(HNS_ROOT_ROUTING_AUTHORITY_TTL_MS).toBe(60_000)
  })
})
