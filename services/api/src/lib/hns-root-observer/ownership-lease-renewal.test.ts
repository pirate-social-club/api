import { afterEach, describe, expect, test } from "bun:test"

import type { Client } from "../sql-client"
import {
  buildTestEnv,
  createControlPlaneTestClient,
  withMockedFetch,
} from "../../../tests/helpers"
import {
  renewHnsOwnershipLease,
  renewHnsOwnershipLeaseFleet,
} from "./ownership-lease-renewal"

const NOW = "2026-08-11T00:00:00.000Z"
const EXPIRED = "2026-08-01T00:00:00.000Z"
const EXPECTED_RENEWAL = "2026-09-10T00:00:00.000Z"
const ROOT = "xn--pokmon-dva"
const CHALLENGE = "pirate-verification=nvs_renewal"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  await cleanup?.()
  cleanup = null
})

async function setup(): Promise<Client> {
  const database = await createControlPlaneTestClient({ includeAllMigrations: true })
  cleanup = database.cleanup
  await seed(database.client)
  return database.client
}

async function seed(client: Client): Promise<void> {
  const acceptedAt = "2026-06-01T00:00:00.000Z"
  await client.batch([
    {
      sql: `
        INSERT INTO users (
          user_id, verification_state, verification_capabilities_json, created_at, updated_at
        ) VALUES ('usr_renewal', 'verified', '[]', ?1, ?1)
      `,
      args: [acceptedAt],
    },
    {
      sql: `
        INSERT INTO communities (
          community_id, creator_user_id, display_name, membership_mode, status,
          provisioning_state, transfer_state, created_at, updated_at
        ) VALUES ('cmt_renewal', 'usr_renewal', 'Renewal Fixture', 'open', 'active',
          'active', 'none', ?1, ?1)
      `,
      args: [acceptedAt],
    },
    {
      sql: `
        INSERT INTO namespace_verification_sessions (
          namespace_verification_session_id, namespace_verification_id, user_id, family,
          submitted_root_label, normalized_root_label, status, challenge_host,
          challenge_txt_value, root_exists, root_control_verified,
          expiry_horizon_sufficient, club_attach_allowed, accepted_at, expires_at,
          created_at, updated_at
        ) VALUES (
          'nvs_renewal', 'nv_renewal', 'usr_renewal', 'hns', ?1, ?1, 'verified',
          NULL, ?2, 1, 1, 1, 1, ?3, ?4, ?3, ?3
        )
      `,
      args: [ROOT, CHALLENGE, acceptedAt, EXPIRED],
    },
    {
      sql: `
        INSERT INTO namespace_verifications (
          namespace_verification_id, source_namespace_verification_session_id, user_id,
          family, normalized_root_label, status, root_exists, root_control_verified,
          expiry_horizon_sufficient, club_attach_allowed, accepted_at, expires_at,
          created_at, updated_at
        ) VALUES (
          'nv_renewal', 'nvs_renewal', 'usr_renewal', 'hns', ?1, 'stale',
          1, 1, 1, 0, ?2, ?3, ?2, ?2
        )
      `,
      args: [ROOT, acceptedAt, EXPIRED],
    },
    {
      sql: `
        INSERT INTO community_namespace_bindings (
          community_namespace_binding_id, community_id, namespace_verification_id,
          namespace_role, status, created_at, updated_at
        ) VALUES ('cnb_renewal', 'cmt_renewal', 'nv_renewal', 'primary', 'active', ?1, ?1)
      `,
      args: [acceptedAt],
    },
    {
      sql: `
        INSERT INTO hns_root_delegation_state (
          normalized_root_label, canonical_routing_eligible, routing_hard_denied,
          rollover_state, state_changed_at, created_at, updated_at
        ) VALUES (?1, 0, 0, 'none', ?2, ?2, ?2)
      `,
      args: [ROOT, acceptedAt],
    },
    ...["root_exists", "root_control_verified", "expiry_horizon_sufficient"].map(
      (assertionName) => ({
        sql: `
          INSERT INTO namespace_verification_assertions (
            assertion_record_id, namespace_verification_session_id,
            namespace_verification_id, family, assertion_name, assertion_value,
            status, first_accepted_at, last_revalidated_at, created_at, updated_at
          ) VALUES (?1, 'nvs_renewal', 'nv_renewal', 'hns', ?2, 1, 'stale', ?3, ?3, ?3, ?3)
        `,
        args: [`nva_renewal_${assertionName}`, assertionName, acceptedAt],
      }),
    ),
    {
      sql: `
        INSERT INTO namespace_verification_capabilities (
          capability_record_id, namespace_verification_session_id,
          namespace_verification_id, family, capability_name, capability_value,
          status, first_accepted_at, last_revalidated_at, created_at, updated_at
        ) VALUES (
          'nvc_renewal_attach', 'nvs_renewal', 'nv_renewal', 'hns',
          'club_attach_allowed', 0, 'stale', ?1, ?1, ?1, ?1
        )
      `,
      args: [acceptedAt],
    },
  ], "write")
}

function env() {
  return buildTestEnv({
    ENVIRONMENT: "test",
    HNS_VERIFIER_BASE_URL: "https://verifier.test/hns",
    HNS_VERIFIER_AUTH_TOKEN: "verifier-token",
  })
}

function verification(overrides: Record<string, unknown> = {}) {
  return {
    verified: true,
    root_label: ROOT,
    observed_values: [CHALLENGE],
    observation_provider: "hns_parent_chain_txt",
    ownership_source: "hns_parent_chain_txt",
    expiry_observation_provider: "hsd_json_rpc",
    expiry_root_exists: true,
    root_control_verified: true,
    expiry_horizon_sufficient: true,
    ...overrides,
  }
}

async function withVerification<T>(
  response: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  return withMockedFetch(
    () => async (request, init) => {
      const normalized = new Request(request, init)
      expect(normalized.url).toBe("https://verifier.test/hns/verify-txt-public")
      expect(normalized.headers.get("authorization")).toBe("Bearer verifier-token")
      const body = await normalized.json() as Record<string, unknown>
      expect(body).toEqual({
        root_label: ROOT,
        challenge_host: null,
        challenge_txt_value: CHALLENGE,
      })
      return Response.json(response)
    },
    run,
  )
}

async function readRow(client: Client, table: string) {
  const result = await client.execute(`SELECT * FROM ${table}`)
  return result.rows[0]
}

function operation(client: Client, apply: boolean) {
  return renewHnsOwnershipLease({
    apply,
    client,
    env: env(),
    now: NOW,
    operatorActorId: "operator_hns",
    reason: "targeted pre-activation ownership renewal",
    rootLabel: ROOT,
  })
}

function fleetOperation(client: Client, applyRenewals: boolean) {
  return renewHnsOwnershipLeaseFleet({
    applyRenewals,
    client,
    env: env(),
    now: NOW,
    operatorActorId: "operator_hns",
    reason: "scheduled HNS ownership lease lifecycle",
  })
}

describe("renewHnsOwnershipLease", () => {
  test("dry-runs an exact stored challenge without mutating the lease", async () => {
    const client = await setup()
    const result = await withVerification(verification(), () => operation(client, false))

    expect(result).toEqual({
      applied: false,
      namespaceVerificationId: "nv_renewal",
      normalizedRootLabel: ROOT,
      outcome: "renewable",
      previousExpiresAt: EXPIRED,
      renewedExpiresAt: EXPECTED_RENEWAL,
      reasonCode: "stored_challenge_confirmed",
    })
    expect((await readRow(client, "namespace_verifications"))?.status).toBe("stale")
    expect((await client.execute("SELECT * FROM audit_log")).rows).toHaveLength(0)
  })

  test("renews an expired stale lease from exact trusted parent-chain evidence", async () => {
    const client = await setup()
    const result = await withVerification(verification(), () => operation(client, true))

    expect(result.applied).toBe(true)
    expect(result.outcome).toBe("renewed")
    const renewed = await readRow(client, "namespace_verifications")
    expect(renewed?.status).toBe("verified")
    expect(renewed?.expires_at).toBe(EXPECTED_RENEWAL)
    expect(renewed?.root_control_verified).toBe(1)
    expect(renewed?.club_attach_allowed).toBe(1)
    expect((await readRow(client, "namespace_verification_sessions"))?.expires_at)
      .toBe(EXPECTED_RENEWAL)
    const assertions = await client.execute({
      sql: `
        SELECT assertion_name, assertion_value, status, last_revalidated_at
        FROM namespace_verification_assertions
        ORDER BY assertion_name
      `,
    })
    expect(assertions.rows).toHaveLength(3)
    expect(assertions.rows.every((row) => (
      row.assertion_value === 1
      && row.status === "accepted"
      && row.last_revalidated_at === NOW
    ))).toBe(true)
    const audit = await readRow(client, "audit_log")
    expect(audit?.action).toBe("hns_namespace.ownership_lease_renew")
    expect(String(audit?.metadata_json)).toContain("fixed_30_days_from_verified_observation")
  })

  test("treats absent TXT evidence as indeterminate and changes nothing", async () => {
    const client = await setup()
    const result = await withVerification(verification({
      verified: false,
      observed_values: [],
      failure_reason: "challenge_not_found",
    }), () => operation(client, true))

    expect(result).toMatchObject({
      applied: false,
      outcome: "indeterminate",
      reasonCode: "challenge_absence_indeterminate",
    })
    expect((await readRow(client, "namespace_verifications"))?.root_control_verified).toBe(1)
    expect((await client.execute("SELECT * FROM audit_log")).rows).toHaveLength(0)
  })

  test("records a present different TXT as a definitive negative", async () => {
    const client = await setup()
    const result = await withVerification(verification({
      verified: false,
      observed_values: ["pirate-verification=another_session"],
      root_control_verified: false,
    }), () => operation(client, true))

    expect(result).toMatchObject({
      applied: true,
      outcome: "definitive_negative",
      reasonCode: "stored_challenge_replaced",
    })
    const verificationRow = await readRow(client, "namespace_verifications")
    expect(verificationRow?.status).toBe("stale")
    expect(verificationRow?.root_control_verified).toBe(0)
    expect(verificationRow?.club_attach_allowed).toBe(0)
    expect((await readRow(client, "namespace_verification_capabilities"))?.capability_value)
      .toBe(0)
    expect((await readRow(client, "audit_log"))?.action)
      .toBe("hns_namespace.ownership_lease_revalidation_failed")
  })

  test("is idempotent within the fixed renewal window", async () => {
    const client = await setup()
    await withVerification(verification(), () => operation(client, true))
    let fetched = false
    const result = await withMockedFetch(
      () => async () => {
        fetched = true
        throw new Error("unexpected verifier call")
      },
      () => operation(client, true),
    )

    expect(result).toMatchObject({
      applied: false,
      outcome: "already_current",
      renewedExpiresAt: EXPECTED_RENEWAL,
    })
    expect(fetched).toBe(false)
    expect((await client.execute("SELECT * FROM audit_log")).rows).toHaveLength(1)
  })

  test("refuses to renew an already activated root", async () => {
    const client = await setup()
    await client.execute({
      sql: `
        UPDATE hns_root_delegation_state
        SET canonical_routing_eligible = 1
        WHERE normalized_root_label = ?1
      `,
      args: [ROOT],
    })

    await expect(operation(client, true)).rejects.toThrow(
      "no inactive, attached ownership verification eligible for renewal",
    )
  })

  test("allows renewal before the observer has seeded a delegation row", async () => {
    const client = await setup()
    await client.execute({
      sql: "DELETE FROM hns_root_delegation_state WHERE normalized_root_label = ?1",
      args: [ROOT],
    })

    const result = await withVerification(verification(), () => operation(client, false))
    expect(result).toMatchObject({
      applied: false,
      outcome: "renewable",
      normalizedRootLabel: ROOT,
    })
  })
})

describe("renewHnsOwnershipLeaseFleet", () => {
  test("renews an activated root from the same exact trusted evidence", async () => {
    const client = await setup()
    await client.execute({
      sql: `
        UPDATE hns_root_delegation_state
        SET canonical_routing_eligible = 1
        WHERE normalized_root_label = ?1
      `,
      args: [ROOT],
    })

    const result = await withVerification(
      verification(),
      () => fleetOperation(client, true),
    )

    expect(result.rootsDiscovered).toBe(1)
    expect(result.counts.renewed).toBe(1)
    expect(result.results[0]).toMatchObject({
      normalizedRootLabel: ROOT,
      result: { applied: true, outcome: "renewed" },
    })
    expect((await readRow(client, "namespace_verifications"))?.expires_at)
      .toBe(EXPECTED_RENEWAL)
    expect((await readRow(client, "hns_root_delegation_state"))?.canonical_routing_eligible)
      .toBe(1)
  })

  test("reports a definitive negative without mutating an activated root", async () => {
    const client = await setup()
    await client.execute({
      sql: `
        UPDATE hns_root_delegation_state
        SET canonical_routing_eligible = 1
        WHERE normalized_root_label = ?1
      `,
      args: [ROOT],
    })

    const result = await withVerification(
      verification({
        verified: false,
        observed_values: ["pirate-verification=another_session"],
        root_control_verified: false,
      }),
      () => fleetOperation(client, true),
    )

    expect(result.counts.definitive_negative).toBe(1)
    expect(result.results[0]).toMatchObject({
      normalizedRootLabel: ROOT,
      result: {
        applied: false,
        outcome: "definitive_negative",
        reasonCode: "stored_challenge_replaced",
      },
    })
    expect((await readRow(client, "namespace_verifications"))?.root_control_verified).toBe(1)
    expect((await readRow(client, "hns_root_delegation_state"))?.canonical_routing_eligible)
      .toBe(1)
    expect((await client.execute("SELECT * FROM audit_log")).rows).toHaveLength(0)
  })

  test("excludes hard-denied roots without calling the verifier", async () => {
    const client = await setup()
    await client.execute({
      sql: `
        UPDATE hns_root_delegation_state
        SET routing_hard_denied = 1
        WHERE normalized_root_label = ?1
      `,
      args: [ROOT],
    })
    let fetched = false

    const result = await withMockedFetch(
      () => async () => {
        fetched = true
        throw new Error("unexpected verifier call")
      },
      () => fleetOperation(client, true),
    )

    expect(result.rootsDiscovered).toBe(0)
    expect(result.results).toEqual([])
    expect(fetched).toBe(false)
    expect((await client.execute("SELECT * FROM audit_log")).rows).toHaveLength(0)
  })

  test("isolates verifier failures without changing ownership state", async () => {
    const client = await setup()
    const result = await withMockedFetch(
      () => async () => new Response("unavailable", { status: 503 }),
      () => fleetOperation(client, true),
    )

    expect(result.rootsDiscovered).toBe(1)
    expect(result.counts.error).toBe(1)
    expect(result.results[0]).toMatchObject({
      normalizedRootLabel: ROOT,
    })
    expect("error" in (result.results[0] ?? {})).toBe(true)
    expect((await readRow(client, "namespace_verifications"))?.root_control_verified).toBe(1)
    expect((await readRow(client, "namespace_verifications"))?.expires_at).toBe(EXPIRED)
    expect((await client.execute("SELECT * FROM audit_log")).rows).toHaveLength(0)
  })
})
