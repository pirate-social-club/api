import { describe, expect, test } from "bun:test"

import {
  classifyReclamationCandidate,
  type ReclamationInventoryRow,
} from "./_lib/staging-d1-reclamation-inventory"

function row(overrides: Partial<ReclamationInventoryRow> = {}): ReclamationInventoryRow {
  return {
    community_id: "cmt_smoke",
    display_name: "Community Create CI Smoke 123",
    description: "Ephemeral staging smoke community for the create/provisioning path.",
    community_status: "archived",
    binding_name: "DB_CMTY_0042",
    provisioning_state: "ready",
    decommissioned_at: null,
    active_jobs: 0,
    pool_community_id: "cmt_smoke",
    pool_version: 7,
    allocated_at: "2026-08-01T00:00:00.000Z",
    last_loaded_at: "2026-08-01T00:00:01.000Z",
    last_error: null,
    released_at: null,
    ...overrides,
  }
}

describe("staging D1 reclamation inventory", () => {
  test("accepts only an archived recognized smoke with matching loaded pool generation", () => {
    expect(classifyReclamationCandidate(row())).toMatchObject({ eligible: true, exclusions: [] })
  })

  test("fails closed on every destructive-boundary ambiguity", () => {
    const decision = classifyReclamationCandidate(row({
      display_name: "Real Community",
      description: "not a smoke",
      community_status: "active",
      binding_name: "DB_CMTY_FIXTURE",
      provisioning_state: "decommissioned",
      decommissioned_at: "2026-08-02T00:00:00.000Z",
      active_jobs: 1,
      pool_community_id: "cmt_other",
      pool_version: null,
      last_loaded_at: null,
      last_error: "decommissioning",
      released_at: "2026-08-02T00:00:00.000Z",
    }))
    expect(decision.eligible).toBe(false)
    expect(decision.exclusions).toEqual([
      "unrecognized_smoke_signature",
      "community_not_archived_or_deleted",
      "reserved_binding",
      "routing_decommissioned",
      "active_job",
      "pool_routing_mismatch",
      "pool_version_missing",
      "binding_not_loaded",
      "decommission_in_progress",
      "pool_row_released",
    ])
  })
})
