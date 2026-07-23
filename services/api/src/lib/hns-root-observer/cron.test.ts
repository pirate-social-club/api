import { afterEach, describe, expect, test } from "bun:test"
import type { Env } from "../../env"
import { createControlPlaneTestClient } from "../../../tests/helpers"
import { observeDueHnsRoots } from "./cron"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function observation(observedAt: string) {
  const digest = "aa".repeat(32)
  return {
    root_label: "pirate",
    zone_name: "pirate.",
    provider: "bind_delv_with_hsd_ds_anchor",
    observed_at: observedAt,
    authoritative_dnssec_valid: true,
    parent_ds_matches_live_dnskey: true,
    earliest_rrsig_expires_at: "2026-08-23T01:00:00.000Z",
    parent: {
      nameservers: ["ns1.pirate.", "ns2.pirate."],
      ds_records: [{
        key_tag: 12345,
        algorithm: 13,
        digest_type: 2,
        digest,
      }],
    },
    parent_ds_results: [{
      key_tag: 12345,
      algorithm: 13,
      digest_type: 2,
      digest,
      supported: true,
      matches_live_dnskey: true,
      failure_code: null,
    }],
    authority_redundancy_ok: true,
    authorities: [
      {
        nameserver: "ns1.pirate.",
        reachable: true,
        soa_serial: "42",
        failure_code: null,
        serial_in_sync: true,
      },
      {
        nameserver: "ns2.pirate.",
        reachable: true,
        soa_serial: "42",
        failure_code: null,
        serial_in_sync: true,
      },
    ],
    required_rrsets: [{
      name: "pirate.",
      type: "DNSKEY",
      validated: true,
      rrsig_expirations: ["2026-08-23T01:00:00.000Z"],
      failure_code: null,
    }],
  }
}

async function seedRoot(client: Awaited<ReturnType<typeof createControlPlaneTestClient>>["client"]) {
  const now = "2026-07-23T10:00:00.000Z"
  await client.execute({
    sql: `
      INSERT INTO hns_root_issued_keysets (
        issued_keyset_id, normalized_root_label, activated_at, retired_at, created_at, updated_at
      ) VALUES ('hks_pirate', 'pirate', ?1, NULL, ?1, ?1)
    `,
    args: [now],
  })
  await client.execute({
    sql: `
      INSERT INTO hns_root_issued_ds (
        issued_ds_id, issued_keyset_id, normalized_root_label, key_tag,
        algorithm, digest_type, digest, derived_at, created_at
      ) VALUES ('hds_pirate', 'hks_pirate', 'pirate', 12345, 13, 2, ?1, ?2, ?2)
    `,
    args: ["aa".repeat(32), now],
  })
  await client.execute({
    sql: `
      INSERT INTO hns_root_delegation_state (
        normalized_root_label, rollover_state, state_changed_at, created_at, updated_at
      ) VALUES ('pirate', 'none', ?1, ?1, ?1)
    `,
    args: [now],
  })
}

describe("HNS root observer cron", () => {
  test("persists both successful observation families in one root transaction", async () => {
    const database = await createControlPlaneTestClient({ includeAllMigrations: true })
    try {
      await seedRoot(database.client)
      globalThis.fetch = (async () => Response.json(
        observation("2026-07-23T10:05:00.000Z"),
      )) as typeof fetch
      const env = {
        ENVIRONMENT: "test",
        HNS_ROOT_OBSERVER_ENABLED: "true",
        HNS_VERIFIER_BASE_URL: "https://verifier.example/hns",
        HNS_VERIFIER_AUTH_TOKEN: "secret",
      } as Env

      expect(await observeDueHnsRoots(
        database.client,
        env,
        new Date("2026-07-23T10:05:00.000Z"),
      )).toEqual({ attempted: 1, succeeded: 1, failed: 0 })

      const parent = (await database.client.execute(`
        SELECT outcome, observed_delegation_security, parent_ds_matches_live_dnskey,
               authoritative_dnssec_valid
        FROM hns_root_parent_observations
      `)).rows
      expect(parent).toEqual([expect.objectContaining({
        outcome: "succeeded",
        observed_delegation_security: "secure",
        parent_ds_matches_live_dnskey: 1,
        authoritative_dnssec_valid: 1,
      })])
      expect((await database.client.execute(
        "SELECT classification, matched_issued_ds_id FROM hns_root_observed_ds",
      )).rows).toEqual([expect.objectContaining({
        classification: "matching",
        matched_issued_ds_id: "hds_pirate",
      })])
      expect((await database.client.execute(
        "SELECT outcome, authority_redundancy_ok FROM hns_root_redundancy_observations",
      )).rows).toEqual([expect.objectContaining({
        outcome: "succeeded",
        authority_redundancy_ok: 1,
      })])
      expect((await database.client.execute(
        "SELECT COUNT(*) AS count FROM hns_root_redundancy_authority_observations",
      )).rows[0]?.count).toBe(2)
    } finally {
      await database.cleanup()
    }
  })

  test("failed polls append attempts without advancing successful freshness", async () => {
    const database = await createControlPlaneTestClient({ includeAllMigrations: true })
    try {
      await seedRoot(database.client)
      const env = {
        ENVIRONMENT: "test",
        HNS_ROOT_OBSERVER_ENABLED: "true",
        HNS_VERIFIER_BASE_URL: "https://verifier.example/hns",
        HNS_VERIFIER_AUTH_TOKEN: "secret",
      } as Env
      globalThis.fetch = (async () => Response.json(
        observation("2026-07-23T10:05:00.000Z"),
      )) as typeof fetch
      await observeDueHnsRoots(database.client, env, new Date("2026-07-23T10:05:00.000Z"))
      const before = (await database.client.execute(`
        SELECT last_parent_observation_id, last_redundancy_observation_id,
               last_redundancy_observation_at
        FROM hns_root_delegation_state WHERE normalized_root_label = 'pirate'
      `)).rows[0]

      globalThis.fetch = (async () => Response.json(
        { error: "unavailable" },
        { status: 503 },
      )) as typeof fetch
      expect(await observeDueHnsRoots(
        database.client,
        env,
        new Date("2026-07-23T10:10:01.000Z"),
      )).toEqual({ attempted: 1, succeeded: 0, failed: 1 })
      const after = (await database.client.execute(`
        SELECT last_parent_observation_id, last_redundancy_observation_id,
               last_redundancy_observation_at,
               last_parent_observation_attempt_at,
               last_redundancy_observation_attempt_at
        FROM hns_root_delegation_state WHERE normalized_root_label = 'pirate'
      `)).rows[0]
      expect(after?.last_parent_observation_id).toBe(before?.last_parent_observation_id)
      expect(after?.last_redundancy_observation_id).toBe(before?.last_redundancy_observation_id)
      expect(after?.last_redundancy_observation_at).toBe(before?.last_redundancy_observation_at)
      expect(after?.last_parent_observation_attempt_at).toBe("2026-07-23T10:10:01.000Z")
      expect(after?.last_redundancy_observation_attempt_at).toBe("2026-07-23T10:10:01.000Z")
      expect((await database.client.execute(`
        SELECT COUNT(*) AS count FROM hns_root_parent_observations WHERE outcome = 'failed'
      `)).rows[0]?.count).toBe(1)
      expect((await database.client.execute(`
        SELECT COUNT(*) AS count FROM hns_root_redundancy_observations WHERE outcome = 'failed'
      `)).rows[0]?.count).toBe(1)
    } finally {
      await database.cleanup()
    }
  })
})
