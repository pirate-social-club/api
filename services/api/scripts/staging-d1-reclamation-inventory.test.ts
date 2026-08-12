import { describe, expect, test } from "bun:test"

import {
  classifyReclamationCandidate,
  parseBindingAllowlist,
  poolDatabaseIdFromConfig,
  resolveReclamationInventoryScope,
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

  test("recognizes exact historical gate-builder and Georgia machine signatures", () => {
    expect(classifyReclamationCandidate(row({
      display_name: "Gate builder staging 1785740000000-abc123",
      description: null,
    })).eligible).toBe(true)
    expect(classifyReclamationCandidate(row({
      display_name: "Georgia Place Smoke 1785740000000-def456",
      description: null,
    })).eligible).toBe(true)
    expect(classifyReclamationCandidate(row({
      display_name: "Gate builder staging customer community",
      description: null,
    })).exclusions).toContain("unrecognized_smoke_signature")
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

const WRANGLER_CONFIG_FIXTURE = `{
  "name": "community-d1-shard-staging",
  "d1_databases": [
    {
      "binding": "D1_POOL",
      "database_name": "community-d1-shard-pool-staging",
      "database_id": "d7d47bef-ffcd-4744-842d-c11b60c52dd8"
    }
  ],
  "env": {
    "production": {
      "name": "community-d1-shard-prod",
      "d1_databases": [
        { "binding": "D1_POOL", "database_name": "community-d1-shard-pool-prod", "database_id": "115ea5db-726a-4786-82c0-0824116bcb2d" }
      ]
    }
  }
}
`

describe("reclamation inventory environment gate", () => {
  test("default run without ENVIRONMENT=staging throws the exact legacy error", () => {
    expect(() => resolveReclamationInventoryScope([], {})).toThrow("refusing_reclamation_inventory_outside_staging")
    expect(() => resolveReclamationInventoryScope([], { ENVIRONMENT: "production" }))
      .toThrow("refusing_reclamation_inventory_outside_staging")
    expect(() => resolveReclamationInventoryScope(["bun", "script.ts", "--output", "x.json"], {}))
      .toThrow("refusing_reclamation_inventory_outside_staging")
  })

  test("staging environment keeps the default staging scope", () => {
    expect(resolveReclamationInventoryScope([], { ENVIRONMENT: "staging" })).toEqual({ environment: "staging" })
    expect(resolveReclamationInventoryScope(["--output", "x.json"], { ENVIRONMENT: " Staging " }))
      .toEqual({ environment: "staging" })
  })

  test("--prod opt-in returns a scoped read-only inventory allowance without mutating env", () => {
    const env: Record<string, string | undefined> = {}
    const scope = resolveReclamationInventoryScope(["--prod"], env)
    expect(scope).toEqual({ environment: "prod", mode: "inventory-readonly" })
    // The allowance is a scoped value, NOT an ENVIRONMENT override: a default
    // run in the same env must still refuse, so write paths keyed on
    // ENVIRONMENT cannot ride the opt-in.
    expect(env.ENVIRONMENT).toBeUndefined()
    expect(() => resolveReclamationInventoryScope([], env)).toThrow("refusing_reclamation_inventory_outside_staging")
  })
})

describe("pool database id resolution", () => {
  test("reads the staging D1_POOL id from the top-level config section", () => {
    expect(poolDatabaseIdFromConfig(WRANGLER_CONFIG_FIXTURE, "staging")).toBe("d7d47bef-ffcd-4744-842d-c11b60c52dd8")
  })

  test("reads the prod D1_POOL id from the env.production config section", () => {
    expect(poolDatabaseIdFromConfig(WRANGLER_CONFIG_FIXTURE, "prod")).toBe("115ea5db-726a-4786-82c0-0824116bcb2d")
  })

  test("fails loudly when the requested section has no D1_POOL binding", () => {
    expect(() => poolDatabaseIdFromConfig(`{ "d1_databases": [] }`, "staging"))
      .toThrow("staging D1_POOL database id not found in wrangler config")
    expect(() => poolDatabaseIdFromConfig(`{ "d1_databases": [] }`, "prod"))
      .toThrow("prod D1_POOL database id not found in wrangler config")
  })
})

describe("prod cohort allowlist", () => {
  test("parses one binding per line, ignoring blanks and comments", () => {
    expect(parseBindingAllowlist("# 2026-08-04 abandoned smoke cohort\nDB_CMTY_0076\n\n  DB_CMTY_0089  \n"))
      .toEqual(new Set(["DB_CMTY_0076", "DB_CMTY_0089"]))
  })

  test("allowlisted prod bindings classify on structural checks, not staging signatures", () => {
    const decision = classifyReclamationCandidate(
      row({ display_name: "Real Prod Community", description: "not a smoke", binding_name: "DB_CMTY_0076" }),
      { mode: "prod-allowlist", allowlist: new Set(["DB_CMTY_0076"]) },
    )
    expect(decision.exclusions).not.toContain("unrecognized_smoke_signature")
    expect(decision).toMatchObject({ eligible: true, exclusions: [] })
  })

  test("staging smoke signatures are not prod evidence outside the allowlist", () => {
    const decision = classifyReclamationCandidate(
      row({ binding_name: "DB_CMTY_0099" }),
      { mode: "prod-allowlist", allowlist: new Set(["DB_CMTY_0076"]) },
    )
    expect(decision.eligible).toBe(false)
    expect(decision.exclusions).toEqual(["outside_prod_cohort_allowlist"])
  })

  test("default classification is unchanged when no evidence is passed", () => {
    expect(classifyReclamationCandidate(row())).toMatchObject({ eligible: true, exclusions: [] })
    expect(classifyReclamationCandidate(row({ display_name: "Real Community", description: "not a smoke" })).exclusions)
      .toContain("unrecognized_smoke_signature")
  })
})
