// Real-Postgres concurrency coverage for funded reward crediting. Runs only when
// BOOKINGS_REPO_TEST_ADMIN_URL is set. It drives the production Postgres client and
// transaction adapters against an isolated database, proving the campaign row lock
// and reservation key admit one credit for one human/song/UTC period.
import { SQL } from "bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import type { Env } from "../../env"
import type { Client } from "../sql-client"
import {
  getControlPlaneClient,
  setControlPlanePostgresPoolFactoryForTests,
  withRequestControlPlaneClients,
} from "../runtime-deps"
import { creditRewardCampaignQualification } from "./reward-campaign-reconciler"
import { monitorRewardCampaigns } from "./reward-campaign-monitor"
import { recoverRewardCampaignIncident } from "./reward-campaign-recovery"

const ADMIN_URL = process.env.BOOKINGS_REPO_TEST_ADMIN_URL
if (process.env.REWARD_CAMPAIGN_PG_CI_REQUIRED === "true" && !ADMIN_URL) {
  throw new Error("BOOKINGS_REPO_TEST_ADMIN_URL is required for reward campaign PostgreSQL CI")
}
const RUN = Boolean(ADMIN_URL)
const TEST_DB = "reward_campaign_credit_test"
const INVARIANTS_MIGRATION_URL = new URL(
  "../../../test-fixtures/db/control-plane/migrations/0136_control_plane_reward_campaign_enable_invariants.sql",
  import.meta.url,
)
const NOW = "2026-07-10T12:00:00.000Z"
const PG_ENV = {
  CONTROL_PLANE_DATABASE_URL: `postgres://rewards@localhost:5432/${TEST_DB}`,
  REWARDS_IDENTITY_PROVIDER: "self",
  REWARDS_CAMPAIGN_ALERT_OWNER: "reward-operator",
  REWARDS_CAMPAIGN_ALERT_DESTINATION: "ops@example.test",
} as unknown as Env

function urlFor(db?: string): string {
  const url = new URL(ADMIN_URL as string)
  if (db) url.pathname = `/${db}`
  if (!url.searchParams.get("sslmode")) url.searchParams.set("sslmode", "disable")
  return url.toString()
}

function connect(db?: string, max = 4): SQL {
  return new SQL({ url: urlFor(db), tls: false, max, connectionTimeout: 5 } as Record<string, unknown>)
}

async function postgresErrorMessage(operation: () => Promise<unknown>): Promise<string> {
  try {
    await operation()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("Expected PostgreSQL statement to be rejected")
}

describe.skipIf(!RUN)("reward campaign credit (real Postgres)", () => {
  beforeAll(async () => {
    const root = connect(undefined, 1)
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
    await root.unsafe(`CREATE DATABASE ${TEST_DB}`)
    await root.end()

    const db = connect(TEST_DB, 1)
    await db.unsafe(`
      CREATE TABLE users (
        user_id TEXT PRIMARY KEY,
        verification_capabilities_json TEXT NOT NULL
      );
      CREATE TABLE identity_nullifiers (
        identity_nullifier_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        mechanism TEXT NOT NULL,
        nullifier_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        first_seen_at TEXT NOT NULL
      );
      CREATE TABLE reward_campaigns (
        reward_campaign_id TEXT PRIMARY KEY,
        campaign_kind TEXT NOT NULL DEFAULT 'song_practice',
        rewarder_user_id TEXT NOT NULL,
        creation_idempotency_key TEXT NOT NULL,
        community_id TEXT NOT NULL,
        post_id TEXT NOT NULL,
        song_artifact_bundle_id TEXT NOT NULL,
        song_owner_user_id TEXT NOT NULL,
        status TEXT NOT NULL,
        eligible_activity TEXT NOT NULL,
        daily_reward_cents INTEGER NOT NULL,
        milestone_7_cents INTEGER NOT NULL DEFAULT 0,
        milestone_30_cents INTEGER NOT NULL DEFAULT 0,
        reward_period_cap_cents INTEGER NOT NULL,
        budget_cents INTEGER NOT NULL,
        funded_cents INTEGER NOT NULL,
        reserved_cents INTEGER NOT NULL,
        credited_cents INTEGER NOT NULL,
        paid_cents INTEGER NOT NULL,
        refunded_cents INTEGER NOT NULL,
        platform_fee_bps INTEGER NOT NULL DEFAULT 0,
        platform_fee_cents INTEGER NOT NULL DEFAULT 0,
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        terms_version INTEGER NOT NULL,
        terms_hash TEXT NOT NULL,
        exhausted_at TEXT,
        updated_at TEXT NOT NULL,
        CHECK (budget_cents >= 0),
        CHECK (funded_cents >= 0 AND funded_cents <= budget_cents),
        CHECK (reserved_cents >= 0 AND credited_cents >= 0 AND paid_cents >= 0 AND refunded_cents >= 0),
        CHECK (reserved_cents + credited_cents + refunded_cents <= funded_cents),
        CHECK (paid_cents <= credited_cents)
      );
      CREATE TABLE reward_song_owner_policies (
        community_id TEXT NOT NULL,
        post_id TEXT NOT NULL,
        third_party_rewards TEXT NOT NULL
      );
      CREATE TABLE reward_campaign_reservations (
        reward_campaign_reservation_id TEXT PRIMARY KEY,
        reward_campaign_id TEXT NOT NULL,
        reward_identity_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        reward_period_key TEXT NOT NULL,
        reward_kind TEXT NOT NULL,
        qualification_basis TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        reward_event_id TEXT,
        reserved_at TEXT NOT NULL,
        credited_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (reward_campaign_id, reward_identity_id, reward_period_key, reward_kind)
      );
      CREATE TABLE reward_events (
        reward_event_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        community_id TEXT NOT NULL,
        post_id TEXT NOT NULL,
        activity_date TEXT NOT NULL,
        reward_kind TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        source TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reward_campaign_id TEXT NOT NULL,
        reward_campaign_reservation_id TEXT NOT NULL UNIQUE,
        reward_identity_id TEXT NOT NULL,
        reward_period_key TEXT NOT NULL,
        qualification_basis TEXT NOT NULL,
        campaign_terms_version INTEGER NOT NULL,
        campaign_rate_snapshot_json TEXT NOT NULL
      );
      CREATE TABLE reward_user_days (
        user_id TEXT NOT NULL,
        activity_date TEXT NOT NULL,
        credited_cents INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, activity_date)
      );
    `)
    await db.unsafe(await readFile(INVARIANTS_MIGRATION_URL, "utf8"))
    await db.unsafe(`
      ALTER TABLE reward_campaigns
        ADD COLUMN status_before_operational_hold TEXT,
        ADD COLUMN operational_hold_reason TEXT,
        ADD COLUMN operational_held_at TIMESTAMPTZ,
        ADD COLUMN operational_held_by TEXT,
        ADD COLUMN operational_recovered_at TIMESTAMPTZ,
        ADD COLUMN operational_recovered_by TEXT;
      CREATE TABLE reward_campaign_funding_effects (
        reward_campaign_funding_effect_id TEXT PRIMARY KEY, reward_campaign_id TEXT NOT NULL,
        tx_hash TEXT, status TEXT NOT NULL, expected_amount_cents INTEGER NOT NULL,
        confirmed_block_number BIGINT, confirmed_block_hash TEXT
      );
      CREATE TABLE reward_campaign_incidents (
        reward_campaign_incident_id TEXT PRIMARY KEY, reward_campaign_id TEXT NOT NULL,
        incident_kind TEXT NOT NULL, reason TEXT NOT NULL, details_json JSONB NOT NULL,
        opened_at TIMESTAMPTZ NOT NULL, last_seen_at TIMESTAMPTZ NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 1, alert_owner TEXT NOT NULL,
        alert_destination TEXT NOT NULL, alerted_at TIMESTAMPTZ, resolved_at TIMESTAMPTZ,
        resolved_by TEXT, resolution_note TEXT, incident_version INTEGER NOT NULL DEFAULT 1
      );
      CREATE UNIQUE INDEX reward_campaign_incidents_one_open_kind
        ON reward_campaign_incidents (reward_campaign_id, incident_kind) WHERE resolved_at IS NULL;
      CREATE TABLE reward_campaign_monitor_state (
        monitor_name TEXT PRIMARY KEY, last_successful_scan_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE VIEW reward_campaign_accounting_reconciliation AS
      SELECT c.reward_campaign_id, c.funded_cents AS stored_funded_cents,
        COALESCE(f.funded, 0) AS computed_funded_cents,
        c.reserved_cents AS stored_reserved_cents,
        COALESCE(r.reserved, 0) AS computed_reserved_cents,
        c.credited_cents AS stored_credited_cents,
        COALESCE(r.credited, 0) AS computed_credited_cents,
        c.refunded_cents AS stored_refunded_cents, 0 AS computed_refunded_cents,
        (c.funded_cents = COALESCE(f.funded, 0) AND c.reserved_cents = COALESCE(r.reserved, 0)
          AND c.credited_cents = COALESCE(r.credited, 0) AND c.refunded_cents = 0) AS counters_match
      FROM reward_campaigns c
      LEFT JOIN (SELECT reward_campaign_id, SUM(expected_amount_cents) AS funded FROM reward_campaign_funding_effects WHERE status = 'confirmed' GROUP BY reward_campaign_id) f USING (reward_campaign_id)
      LEFT JOIN (SELECT reward_campaign_id,
        SUM(CASE WHEN status = 'reserved' THEN amount_cents ELSE 0 END) AS reserved,
        SUM(CASE WHEN status = 'credited' THEN amount_cents ELSE 0 END) AS credited
        FROM reward_campaign_reservations GROUP BY reward_campaign_id) r USING (reward_campaign_id);
    `)
    await db.unsafe(
      `INSERT INTO users VALUES ($1, $2)`,
      ["usr_reward_pg", JSON.stringify({
        unique_human: {
          state: "verified", provider: "self", proof_type: "passport",
          mechanism: "passport", verified_at: NOW,
        },
      })],
    )
    await db.unsafe(
      `INSERT INTO identity_nullifiers VALUES ($1, $2, 'self', 'passport', $3, 'active', $4)`,
      ["idn_reward_pg", "usr_reward_pg", "stable-nullifier", NOW],
    )
    await db.unsafe(`
      INSERT INTO reward_campaigns (
        reward_campaign_id, rewarder_user_id, creation_idempotency_key,
        community_id, post_id, song_artifact_bundle_id, song_owner_user_id,
        status, eligible_activity, daily_reward_cents, reward_period_cap_cents,
        budget_cents, funded_cents, reserved_cents, credited_cents, paid_cents,
        refunded_cents, terms_version, terms_hash, starts_at, ends_at, updated_at
      ) VALUES (
        'rcp_reward_pg', 'usr_reward_pg', 'create-reward-pg', 'cmt_reward_pg',
        'pst_reward_pg', 'sab_reward_pg', 'usr_reward_pg', 'active', 'either',
        40, 40, 100, 100, 0, 0, 0, 0, 1, 'terms-reward-pg',
        '2026-07-01T00:00:00.000Z', '2026-07-31T23:59:59.999Z', $1
      )
    `, [NOW])
    await db.unsafe(`
      INSERT INTO reward_campaigns (
        reward_campaign_id, rewarder_user_id, creation_idempotency_key,
        community_id, post_id, song_artifact_bundle_id, song_owner_user_id,
        status, eligible_activity, daily_reward_cents, reward_period_cap_cents,
        budget_cents, funded_cents, reserved_cents, credited_cents, paid_cents,
        refunded_cents, terms_version, terms_hash, starts_at, ends_at, updated_at
      ) VALUES
      (
        'rcp_ended_grace_pg', 'usr_budget_a', 'create-ended-grace-pg', 'cmt_reward_pg',
        'pst_ended_grace_pg', 'sab_ended_grace_pg', 'usr_budget_a', 'ended', 'study',
        40, 40, 40, 40, 0, 0, 0, 0, 1, 'terms-ended-grace-pg',
        '2026-07-01T00:00:00.000Z', '2026-07-11T00:00:00.000Z', $1
      ),
      (
        'rcp_expiry_race_pg', 'usr_reward_pg', 'create-expiry-race-pg', 'cmt_reward_pg',
        'pst_expiry_race_pg', 'sab_expiry_race_pg', 'usr_reward_pg', 'active', 'study',
        40, 40, 40, 40, 0, 0, 0, 0, 1, 'terms-expiry-race-pg',
        '2026-07-01T00:00:00.000Z', '2026-07-31T23:59:59.999Z', $1
      )
    `, [NOW])
    for (const suffix of ["a", "b"] as const) {
      await db.unsafe(
        `INSERT INTO users VALUES ($1, $2)`,
        [`usr_budget_${suffix}`, JSON.stringify({
          unique_human: {
            state: "verified", provider: "self", proof_type: "passport",
            mechanism: "passport", verified_at: NOW,
          },
        })],
      )
      await db.unsafe(
        `INSERT INTO identity_nullifiers VALUES ($1, $2, 'self', 'passport', $3, 'active', $4)`,
        [`idn_budget_${suffix}`, `usr_budget_${suffix}`, `budget-nullifier-${suffix}`, NOW],
      )
    }
    await db.unsafe(`
      INSERT INTO reward_campaigns (
        reward_campaign_id, rewarder_user_id, creation_idempotency_key,
        community_id, post_id, song_artifact_bundle_id, song_owner_user_id,
        status, eligible_activity, daily_reward_cents, reward_period_cap_cents,
        budget_cents, funded_cents, reserved_cents, credited_cents, paid_cents,
        refunded_cents, terms_version, terms_hash, starts_at, ends_at, updated_at
      ) VALUES (
        'rcp_budget_pg', 'usr_budget_a', 'create-budget-pg', 'cmt_reward_pg',
        'pst_budget_pg', 'sab_budget_pg', 'usr_budget_a', 'active', 'either',
        40, 40, 40, 40, 0, 0, 0, 0, 1, 'terms-budget-pg',
        '2026-07-01T00:00:00.000Z', '2026-07-31T23:59:59.999Z', $1
      )
    `, [NOW])
    await db.unsafe(`
      INSERT INTO reward_campaigns (
        reward_campaign_id, rewarder_user_id, creation_idempotency_key,
        community_id, post_id, song_artifact_bundle_id, song_owner_user_id,
        status, eligible_activity, daily_reward_cents, reward_period_cap_cents,
        budget_cents, funded_cents, reserved_cents, credited_cents, paid_cents,
        refunded_cents, terms_version, terms_hash, starts_at, ends_at, updated_at
      ) VALUES (
        'rcp_invariants_pg', 'usr_reward_pg', 'create-invariants-pg', 'cmt_reward_pg',
        'pst_invariants_pg', 'sab_invariants_pg', 'usr_reward_pg', 'draft', 'study',
        25, 25, 100, 0, 0, 0, 0, 0, 1, 'terms-invariants-pg',
        '2026-07-01T00:00:00.000Z', '2026-07-31T23:59:59.999Z', $1
      )
    `, [NOW])
    await db.end()
  })

  afterAll(async () => {
    setControlPlanePostgresPoolFactoryForTests(null)
    const root = connect(undefined, 1)
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {})
    await root.end()
    const sentinelPath = process.env.REWARD_CAMPAIGN_PG_SENTINEL_PATH
    if (sentinelPath) {
      await writeFile(sentinelPath, "reward-campaign-postgres-suite-complete\n", "utf8")
    }
  })

  async function withProductionPostgresClient<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    const base = connect(TEST_DB, 4)
    setControlPlanePostgresPoolFactoryForTests(() => ({
      query: async (sql, values) => ({
        rows: (await base.unsafe(sql, values ?? [])) as Record<string, unknown>[],
        rowCount: null,
      }),
      connect: async () => {
        const dedicated = connect(TEST_DB, 1)
        return {
          query: async (sql, values) => ({
            rows: (await dedicated.unsafe(sql, values ?? [])) as Record<string, unknown>[],
            rowCount: null,
          }),
          release: () => { void dedicated.end() },
        }
      },
      end: async () => { await base.end() },
    }))
    try {
      return await withRequestControlPlaneClients(() => operation(getControlPlaneClient(PG_ENV)))
    } finally {
      setControlPlanePostgresPoolFactoryForTests(null)
    }
  }

  test("concurrent qualifications create exactly one credited reservation and ledger event", async () => {
    await withProductionPostgresClient(async (client) => {
        const candidate = {
          eventId: "rqe_reward_pg",
          userId: "usr_reward_pg",
          communityId: "cmt_reward_pg",
          postId: "pst_reward_pg",
          artifactBundleId: "sab_reward_pg",
          activity: "study" as const,
          qualifiedAt: NOW,
          periodKey: "2026-07-10",
          policyVersion: "study-completed-set-v1",
        }
        const results = await Promise.all([
          creditRewardCampaignQualification({ env: PG_ENV, client, candidate, now: NOW }),
          creditRewardCampaignQualification({ env: PG_ENV, client, candidate, now: NOW }),
        ])
        expect(results.map((result) => result.result).sort()).toEqual(["credited", "duplicate"])
    })

    const verify = connect(TEST_DB, 1)
    const reservations = await verify.unsafe(
      `SELECT status, amount_cents FROM reward_campaign_reservations ORDER BY reward_campaign_reservation_id`,
    ) as Array<{ status: string; amount_cents: number }>
    const events = await verify.unsafe(`SELECT amount_cents FROM reward_events`) as Array<{ amount_cents: number }>
    const campaigns = await verify.unsafe(
      `SELECT funded_cents, reserved_cents, credited_cents FROM reward_campaigns WHERE reward_campaign_id = 'rcp_reward_pg'`,
    ) as Array<{ funded_cents: number; reserved_cents: number; credited_cents: number }>
    await verify.end()
    expect(reservations).toEqual([{ status: "credited", amount_cents: 40 }])
    expect(events).toEqual([{ amount_cents: 40 }])
    expect(campaigns).toEqual([{ funded_cents: 100, reserved_cents: 0, credited_cents: 40 }])
  })

  test("different identities racing for the final budget admit one full credit", async () => {
    const results = await withProductionPostgresClient(async (client) => Promise.all(
      (["a", "b"] as const).map((suffix) => creditRewardCampaignQualification({
        env: PG_ENV,
        client,
        candidate: {
          eventId: `rqe_budget_${suffix}`,
          userId: `usr_budget_${suffix}`,
          communityId: "cmt_reward_pg",
          postId: "pst_budget_pg",
          artifactBundleId: "sab_budget_pg",
          activity: "study",
          qualifiedAt: NOW,
          periodKey: "2026-07-10",
          policyVersion: "study-completed-set-v1",
        },
        now: NOW,
      })),
    ))
    expect(results.map((result) => result.result).sort()).toEqual(["budget", "credited"])

    const verify = connect(TEST_DB, 1)
    const reservations = await verify.unsafe(
      `SELECT status, amount_cents FROM reward_campaign_reservations WHERE reward_campaign_id = 'rcp_budget_pg'`,
    ) as Array<{ status: string; amount_cents: number }>
    const campaigns = await verify.unsafe(
      `SELECT status, funded_cents, reserved_cents, credited_cents FROM reward_campaigns WHERE reward_campaign_id = 'rcp_budget_pg'`,
    ) as Array<{ status: string; funded_cents: number; reserved_cents: number; credited_cents: number }>
    await verify.end()
    expect(reservations).toEqual([{ status: "credited", amount_cents: 40 }])
    expect(campaigns).toEqual([{ status: "exhausted", funded_cents: 40, reserved_cents: 0, credited_cents: 40 }])
  })

  test("pre-end qualifications remain claimable during grace and exhaustion rejects the next identity", async () => {
    const candidate = {
      communityId: "cmt_reward_pg",
      postId: "pst_ended_grace_pg",
      artifactBundleId: "sab_ended_grace_pg",
      activity: "study" as const,
      qualifiedAt: "2026-07-10T23:59:00.000Z",
      periodKey: "2026-07-10",
      policyVersion: "study-completed-set-v1",
    }
    const results = await withProductionPostgresClient(async (client) => {
      const credited = await creditRewardCampaignQualification({
        env: PG_ENV,
        client,
        candidate: { ...candidate, eventId: "rqe_ended_grace_a", userId: "usr_budget_a" },
        now: "2026-07-17T23:58:59.999Z",
      })
      const exhausted = await creditRewardCampaignQualification({
        env: PG_ENV,
        client,
        candidate: { ...candidate, eventId: "rqe_ended_grace_b", userId: "usr_budget_b" },
        now: "2026-07-17T23:58:59.999Z",
      })
      return [credited.result, exhausted.result]
    })
    expect(results).toEqual(["credited", "budget"])

    const verify = connect(TEST_DB, 1)
    const campaigns = await verify.unsafe(`
      SELECT status, credited_cents FROM reward_campaigns
      WHERE reward_campaign_id = 'rcp_ended_grace_pg'
    `) as Array<{ status: string; credited_cents: number }>
    await verify.end()
    expect(campaigns).toEqual([{ status: "exhausted", credited_cents: 40 }])
  })

  test("expiry is rechecked after the campaign lock before reserving money", async () => {
    const result = await withProductionPostgresClient((client) => creditRewardCampaignQualification({
      env: PG_ENV,
      client,
      candidate: {
        eventId: "rqe_expiry_race",
        userId: "usr_reward_pg",
        communityId: "cmt_reward_pg",
        postId: "pst_expiry_race_pg",
        artifactBundleId: "sab_expiry_race_pg",
        activity: "study",
        qualifiedAt: "2026-07-10T00:01:00.000Z",
        periodKey: "2026-07-10",
        policyVersion: "study-completed-set-v1",
      },
      now: "2026-07-17T00:00:59.999Z",
      currentTime: () => "2026-07-17T00:01:00.000Z",
    }))
    expect(result).toEqual({ result: "expired", amountCents: 0 })

    const verify = connect(TEST_DB, 1)
    const reservations = await verify.unsafe(`
      SELECT count(*)::int AS count FROM reward_campaign_reservations
      WHERE reward_campaign_id = 'rcp_expiry_race_pg'
    `) as Array<{ count: number }>
    await verify.end()
    expect(reservations).toEqual([{ count: 0 }])
  })

  test("canonical 0136 trigger rejects campaign term mutations", async () => {
    const db = connect(TEST_DB, 1)
    try {
      const message = await postgresErrorMessage(() => db.unsafe(`
        UPDATE reward_campaigns SET daily_reward_cents = 30
        WHERE reward_campaign_id = 'rcp_invariants_pg'
      `))
      expect(message).toContain("reward campaign terms are immutable")
    } finally {
      await db.end()
    }
  })

  test("canonical 0136 check rejects nonzero milestone campaigns", async () => {
    const db = connect(TEST_DB, 1)
    try {
      const message = await postgresErrorMessage(() => db.unsafe(`
        INSERT INTO reward_campaigns (
          reward_campaign_id, rewarder_user_id, creation_idempotency_key,
          community_id, post_id, song_artifact_bundle_id, song_owner_user_id,
          status, eligible_activity, daily_reward_cents, milestone_7_cents,
          milestone_30_cents, reward_period_cap_cents, budget_cents, funded_cents,
          reserved_cents, credited_cents, paid_cents, refunded_cents, terms_version,
          terms_hash, starts_at, ends_at, updated_at
        ) VALUES (
          'rcp_milestone_rejected_pg', 'usr_reward_pg', 'create-milestone-pg',
          'cmt_reward_pg', 'pst_milestone_pg', 'sab_milestone_pg', 'usr_reward_pg',
          'draft', 'study', 25, 10, 0, 35, 100, 0, 0, 0, 0, 0, 1,
          'terms-milestone-pg', '2026-07-01T00:00:00.000Z',
          '2026-07-31T23:59:59.999Z', $1
        )
      `, [NOW]))
      expect(message).toContain("reward_campaigns_pilot_milestones_disabled_check")
    } finally {
      await db.end()
    }
  })

  test("canonical 0136 trigger permits lifecycle and accounting updates", async () => {
    const db = connect(TEST_DB, 1)
    try {
      await db.unsafe(`
        UPDATE reward_campaigns
        SET status = 'paused', funded_cents = 50, reserved_cents = 10, updated_at = $1
        WHERE reward_campaign_id = 'rcp_invariants_pg'
      `, ["2026-07-10T12:05:00.000Z"])
      const rows = await db.unsafe(`
        SELECT status, funded_cents, reserved_cents
        FROM reward_campaigns WHERE reward_campaign_id = 'rcp_invariants_pg'
      `) as Array<{ status: string; funded_cents: number; reserved_cents: number }>
      expect(rows).toEqual([{ status: "paused", funded_cents: 50, reserved_cents: 10 }])
    } finally {
      await db.end()
    }
  })

  test("persistent accounting mismatch holds only on the second scan and recovery clears hold metadata", async () => {
    await withProductionPostgresClient(async (client) => {
      await client.execute({
        sql: `UPDATE reward_campaigns SET status = 'paused', funded_cents = 50, reserved_cents = 10 WHERE reward_campaign_id = 'rcp_invariants_pg'`,
        args: [],
      })
      const first = await monitorRewardCampaigns({ env: PG_ENV, client, now: "2026-07-10T12:10:00.000Z" })
      expect(first.held).toBe(0)
      const overlapping = await monitorRewardCampaigns({ env: PG_ENV, client, now: "2026-07-10T12:10:20.000Z" })
      expect(overlapping.held).toBe(0)
      let campaign = await client.execute({ sql: `SELECT status FROM reward_campaigns WHERE reward_campaign_id = 'rcp_invariants_pg'`, args: [] })
      expect(campaign.rows[0]?.status).toBe("paused")
      const second = await monitorRewardCampaigns({ env: PG_ENV, client, now: "2026-07-10T12:11:00.000Z" })
      expect(second.held).toBeGreaterThanOrEqual(1)
      campaign = await client.execute({ sql: `SELECT status, status_before_operational_hold FROM reward_campaigns WHERE reward_campaign_id = 'rcp_invariants_pg'`, args: [] })
      expect(campaign.rows[0]).toMatchObject({ status: "operational_hold", status_before_operational_hold: "paused" })
      const heldCredit = await creditRewardCampaignQualification({
        env: PG_ENV,
        client,
        candidate: {
          eventId: "qual-held-pg", userId: "usr_reward_pg", communityId: "cmt_reward_pg",
          postId: "pst_invariants_pg", artifactBundleId: "sab_invariants_pg",
          activity: "study", qualifiedAt: NOW, periodKey: "2026-07-10",
          policyVersion: "study-v1",
        },
        now: NOW,
      })
      expect(heldCredit.result).toBe("no_campaign")
      const heldReservations = await client.execute({
        sql: `SELECT COUNT(*) AS count FROM reward_campaign_reservations WHERE reward_campaign_id = 'rcp_invariants_pg'`,
        args: [],
      })
      expect(Number(heldReservations.rows[0]?.count)).toBe(0)

      await client.execute({
        sql: `UPDATE reward_campaigns SET funded_cents = 0, reserved_cents = 0 WHERE reward_campaign_id = 'rcp_invariants_pg'`,
        args: [],
      })
      const incidents = await client.execute({
        sql: `SELECT reward_campaign_incident_id, incident_version FROM reward_campaign_incidents WHERE reward_campaign_id = 'rcp_invariants_pg' AND incident_kind = 'accounting_mismatch' AND resolved_at IS NULL`,
        args: [],
      })
      const incident = incidents.rows[0] as Record<string, unknown>
      await expect(recoverRewardCampaignIncident({
        env: PG_ENV, client, campaignId: "rcp_invariants_pg",
        incidentId: String(incident.reward_campaign_incident_id),
        incidentVersion: Number(incident.incident_version) + 1, operatorActorId: "operator-test",
        resolutionNote: "Stale recovery attempt", now: "2026-07-10T12:12:00.000Z",
      })).rejects.toThrow("incident changed")
      await recoverRewardCampaignIncident({
        env: PG_ENV, client, campaignId: "rcp_invariants_pg",
        incidentId: String(incident.reward_campaign_incident_id),
        incidentVersion: Number(incident.incident_version), operatorActorId: "operator-test",
        resolutionNote: "Authoritative counters restored", now: "2026-07-10T12:12:00.000Z",
      })
      campaign = await client.execute({
        sql: `SELECT status, status_before_operational_hold, operational_held_at, operational_held_by, operational_hold_reason FROM reward_campaigns WHERE reward_campaign_id = 'rcp_invariants_pg'`,
        args: [],
      })
      expect(campaign.rows[0]).toEqual({
        status: "paused", status_before_operational_hold: null, operational_held_at: null,
        operational_held_by: null, operational_hold_reason: null,
      })
    })
  })

  test("recovery rechecks accounting after waiting for the campaign row lock", async () => {
    const db = connect(TEST_DB, 1)
    try {
      await db.unsafe(`
        INSERT INTO reward_campaigns (
          reward_campaign_id, rewarder_user_id, creation_idempotency_key, community_id,
          post_id, song_artifact_bundle_id, song_owner_user_id, status, eligible_activity,
          daily_reward_cents, reward_period_cap_cents, budget_cents, funded_cents,
          reserved_cents, credited_cents, paid_cents, refunded_cents, terms_version,
          terms_hash, starts_at, ends_at, updated_at, status_before_operational_hold,
          operational_hold_reason, operational_held_at, operational_held_by
        ) VALUES (
          'rcp_recovery_race_pg', 'usr_reward_pg', 'recovery-race-pg', 'cmt_reward_pg',
          'pst_recovery_race_pg', 'sab_recovery_race_pg', 'usr_reward_pg',
          'operational_hold', 'study', 40, 40, 100, 0, 0, 0, 0, 0, 1,
          'terms-recovery-race', '2026-07-01T00:00:00.000Z',
          '2026-07-31T00:00:00.000Z', $1, 'active', 'accounting mismatch', $2,
          'scheduled_monitor'
        )
      `, [NOW, NOW])
      await db.unsafe(`
        INSERT INTO reward_campaign_incidents (
          reward_campaign_incident_id, reward_campaign_id, incident_kind, reason,
          details_json, opened_at, last_seen_at, alert_owner, alert_destination
        ) VALUES (
          'rci_recovery_race_pg', 'rcp_recovery_race_pg', 'accounting_mismatch',
          'campaign_accounting_counters_mismatch', '{}', $1, $1,
          'reward-operator', 'ops@example.test'
        )
      `, [NOW])
      await db.unsafe("BEGIN")
      await db.unsafe(`SELECT reward_campaign_id FROM reward_campaigns WHERE reward_campaign_id = 'rcp_recovery_race_pg' FOR UPDATE`)
      await db.unsafe(`UPDATE reward_campaigns SET funded_cents = 10 WHERE reward_campaign_id = 'rcp_recovery_race_pg'`)

      const recovery = withProductionPostgresClient((client) => recoverRewardCampaignIncident({
        env: PG_ENV, client, campaignId: "rcp_recovery_race_pg",
        incidentId: "rci_recovery_race_pg", incidentVersion: 1,
        operatorActorId: "operator-test", resolutionNote: "Attempt while writer commits",
        now: "2026-07-10T12:30:00.000Z",
      }))
      await Bun.sleep(50)
      await db.unsafe("COMMIT")
      await expect(recovery).rejects.toThrow("accounting is not healthy")
      const rows = await db.unsafe(`SELECT status FROM reward_campaigns WHERE reward_campaign_id = 'rcp_recovery_race_pg'`) as Array<{ status: string }>
      expect(rows[0]?.status).toBe("operational_hold")
    } finally {
      await db.unsafe("ROLLBACK").catch(() => {})
      await db.end()
    }
  })

  test("missing provenance records without holding and terminal mismatches preserve terminal state", async () => {
    const db = connect(TEST_DB, 1)
    try {
      await db.unsafe(`
        INSERT INTO reward_campaigns (
          reward_campaign_id, rewarder_user_id, creation_idempotency_key, community_id,
          post_id, song_artifact_bundle_id, song_owner_user_id, status, eligible_activity,
          daily_reward_cents, reward_period_cap_cents, budget_cents, funded_cents,
          reserved_cents, credited_cents, paid_cents, refunded_cents, terms_version,
          terms_hash, starts_at, ends_at, updated_at
        ) VALUES
          ('rcp_provenance_pg', 'usr_reward_pg', 'provenance-pg', 'cmt_reward_pg',
           'pst_provenance_pg', 'sab_provenance_pg', 'usr_reward_pg', 'active', 'study',
           40, 40, 40, 40, 0, 0, 0, 0, 1, 'terms-provenance',
           '2026-07-01T00:00:00.000Z', '2026-07-31T00:00:00.000Z', $1),
          ('rcp_terminal_pg', 'usr_reward_pg', 'terminal-pg', 'cmt_reward_pg',
           'pst_terminal_pg', 'sab_terminal_pg', 'usr_reward_pg', 'ended', 'study',
           40, 40, 40, 40, 0, 0, 0, 0, 1, 'terms-terminal',
           '2026-07-01T00:00:00.000Z', '2026-07-09T00:00:00.000Z', $1)
      `, [NOW])
      await db.unsafe(`
        INSERT INTO reward_campaign_funding_effects (
          reward_campaign_funding_effect_id, reward_campaign_id, tx_hash, status, expected_amount_cents
        ) VALUES ('rcf_provenance_pg', 'rcp_provenance_pg', $1, 'confirmed', 40)
      `, [`0x${"1".repeat(64)}`])
    } finally {
      await db.end()
    }
    await withProductionPostgresClient(async (client) => {
      await monitorRewardCampaigns({ env: PG_ENV, client, now: "2026-07-10T13:00:00.000Z" })
      await monitorRewardCampaigns({ env: PG_ENV, client, now: "2026-07-10T13:01:00.000Z" })
      const campaigns = await client.execute({
        sql: `SELECT reward_campaign_id, status FROM reward_campaigns WHERE reward_campaign_id IN ('rcp_provenance_pg', 'rcp_terminal_pg') ORDER BY reward_campaign_id`,
        args: [],
      })
      expect(campaigns.rows).toEqual([
        { reward_campaign_id: "rcp_provenance_pg", status: "active" },
        { reward_campaign_id: "rcp_terminal_pg", status: "ended" },
      ])
      const provenance = await client.execute({
        sql: `SELECT occurrence_count FROM reward_campaign_incidents WHERE reward_campaign_id = 'rcp_provenance_pg' AND incident_kind = 'funding_provenance_missing' AND resolved_at IS NULL`,
        args: [],
      })
      expect(Number(provenance.rows[0]?.occurrence_count)).toBe(2)
    })
  })
})
