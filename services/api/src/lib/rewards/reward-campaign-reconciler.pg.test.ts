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
})
