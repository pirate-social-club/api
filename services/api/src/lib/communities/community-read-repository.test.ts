import { createClient } from "@libsql/client"
import { describe, expect, test } from "bun:test"
import { listCommunityNamespaceAttachments } from "./community-read-repository"

async function setup() {
  const client = createClient({ url: ":memory:" })
  await client.execute(`
    CREATE TABLE community_namespace_bindings (
      community_namespace_binding_id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      namespace_verification_id TEXT NOT NULL,
      namespace_role TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  await client.execute(`
    CREATE TABLE namespace_verifications (
      namespace_verification_id TEXT PRIMARY KEY,
      family TEXT NOT NULL,
      normalized_root_label TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      club_attach_allowed INTEGER,
      pirate_dns_authority_verified INTEGER,
      pirate_web_routing_allowed INTEGER
    )
  `)
  await client.execute(`
    CREATE TABLE hns_root_delegation_state (
      normalized_root_label TEXT PRIMARY KEY,
      rollover_state TEXT NOT NULL,
      pending_evidence_kind TEXT,
      authority_redundancy_ok INTEGER,
      authority_redundancy_evidence_class TEXT,
      last_redundancy_observation_at TEXT,
      canonical_routing_eligible INTEGER NOT NULL DEFAULT 0,
      routing_hard_denied INTEGER NOT NULL DEFAULT 0,
      last_parent_observation_id TEXT
    )
  `)
  await client.execute(`
    CREATE TABLE hns_root_parent_observations (
      parent_observation_id TEXT PRIMARY KEY,
      normalized_root_label TEXT NOT NULL,
      observed_delegation_security TEXT,
      parent_ds_matches_live_dnskey INTEGER,
      authoritative_dnssec_valid INTEGER,
      observed_at TEXT,
      earliest_rrsig_expires_at TEXT
    )
  `)
  return client
}

async function insertHns(client: Awaited<ReturnType<typeof setup>>, input: {
  id: string
  expiresAt?: string
  authority?: number
  routing?: number
}) {
  await client.execute({
    sql: `
      INSERT INTO namespace_verifications (
        namespace_verification_id, family, normalized_root_label, status, expires_at,
        club_attach_allowed, pirate_dns_authority_verified, pirate_web_routing_allowed
      ) VALUES (?1, 'hns', 'dankmeme', 'verified', ?2, 1, ?3, ?4)
    `,
    args: [input.id, input.expiresAt ?? "2099-01-01T00:00:00.000Z", input.authority ?? 1, input.routing ?? 1],
  })
  await client.execute({
    sql: `
      INSERT INTO community_namespace_bindings (
        community_namespace_binding_id, community_id, namespace_verification_id,
        namespace_role, status, created_at, updated_at
      ) VALUES (?1, 'cmt_test', ?2, 'primary', 'active',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `,
    args: [`cnb_${input.id}`, input.id],
  })
}

describe("listCommunityNamespaceAttachments", () => {
  test("keeps ownership verified while routing observation is unavailable", async () => {
    const client = await setup()
    await insertHns(client, { id: "nv_stale", authority: 0, routing: 0 })

    const rows = await listCommunityNamespaceAttachments(client, "cmt_test")

    expect(rows[0]?.verificationStatus).toBe("verified")
    expect(rows[0]?.delegation).toMatchObject({
      delegation_security: "unknown",
      pirate_web_routing_allowed: false,
    })
    client.close()
  })

  test("reports HNS verified only while current routing capabilities remain valid", async () => {
    const client = await setup()
    await insertHns(client, { id: "nv_live" })

    const rows = await listCommunityNamespaceAttachments(client, "cmt_test")

    expect(rows[0]?.verificationStatus).toBe("verified")
    expect(rows[0]?.delegation?.pirate_web_routing_allowed).toBe(false)
    client.close()
  })

  test("reports an expired verification as expired even when its capability snapshot is true", async () => {
    const client = await setup()
    await insertHns(client, { id: "nv_expired", expiresAt: "2020-01-01T00:00:00.000Z" })

    const rows = await listCommunityNamespaceAttachments(client, "cmt_test")

    expect(rows[0]?.verificationStatus).toBe("expired")
    client.close()
  })
})
