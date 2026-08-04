// Real-Postgres concurrency coverage for funded reward crediting. Runs only when
// BOOKINGS_REPO_TEST_ADMIN_URL is set. It drives the production Postgres client and
// transaction adapters against an isolated database, proving the campaign row lock
// and reservation key admit one credit for one human/song/UTC period.
import { SQL } from "bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFile, writeFile } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"
import type { Env } from "../../env"
import type { Client } from "../sql-client"
import {
  getControlPlaneClient,
  setControlPlanePostgresPoolFactoryForTests,
  withRequestControlPlaneClients,
} from "../runtime-deps"
import {
  creditRewardCampaignQualification,
  expirePendingRewardQualifications,
} from "./reward-campaign-reconciler"
import { markRewardCampaignIncidentAlerted, monitorRewardCampaigns } from "./reward-campaign-monitor"
import { recoverRewardCampaignIncident } from "./reward-campaign-recovery"
import { REWARD_PAYOUT_COORDINATOR_MIRROR_SQL } from "./reward-cashout-service"
import type { RewardCampaignFinalityProvider } from "./reward-campaign-finality"
import { REWARD_SONG_POOL_REGISTER_SQL } from "./reward-campaign-service"

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
const SONG_PERIOD_CLAIMS_MIGRATION_URL = new URL(
  "../../../test-fixtures/db/control-plane/migrations/0142_control_plane_reward_song_period_claims.sql",
  import.meta.url,
)
const SCORE_TERMS_MIGRATION_URL = new URL(
  "../../../test-fixtures/db/control-plane/migrations/0144_control_plane_reward_campaign_score_terms.sql",
  import.meta.url,
)
const PAYOUT_EFFECTS_MIGRATION_URL = new URL(
  "../../../test-fixtures/db/control-plane/migrations/0132_control_plane_reward_payout_effects.sql",
  import.meta.url,
)
const SONG_SLOTS_MIGRATION_URL = new URL(
  "../../../test-fixtures/db/control-plane/migrations/0147_control_plane_reward_song_slots.sql",
  import.meta.url,
)
const CONCURRENT_POOLS_MIGRATION_URL = new URL(
  "../../../test-fixtures/db/control-plane/migrations/0159_control_plane_reward_concurrent_pools.sql",
  import.meta.url,
)
const NATIONALITY_TIERS_MIGRATION_URL = new URL(
  "../../../test-fixtures/db/control-plane/migrations/0177_control_plane_reward_campaign_nationality_tiers.sql",
  import.meta.url,
)
const NATIONALITY_DECISIONS_MIGRATION_URL = new URL(
  "../../../test-fixtures/db/control-plane/migrations/0187_control_plane_reward_nationality_decisions.sql",
  import.meta.url,
)
const IDENTITY_PROVIDER_MIGRATION_URL = new URL(
  "../../../test-fixtures/db/control-plane/migrations/0188_control_plane_reward_campaign_identity_provider.sql",
  import.meta.url,
)
const TIER_ACCOUNTING_MIGRATION_URL = new URL(
  "../../../test-fixtures/db/control-plane/migrations/0189_control_plane_reward_tier_accounting.sql",
  import.meta.url,
)
const NOW = "2026-07-10T12:00:00.000Z"
const PG_ENV = {
  CONTROL_PLANE_DATABASE_URL: `postgres://rewards@localhost:5432/${TEST_DB}`,
  // Deliberately disagrees with seeded `self` pools. Campaign terms, not this
  // legacy environment default, must select the identity namespace.
  REWARDS_IDENTITY_PROVIDER: "very",
  REWARDS_CAMPAIGNS_ENABLED: "true",
  REWARDS_ACCRUAL_ENABLED: "true",
  REWARDS_PAYOUTS_ENABLED: "true",
  REWARDS_CAMPAIGN_ALERT_OWNER: "reward-operator",
  REWARDS_CAMPAIGN_ALERT_DESTINATION: "ops@example.test",
  OPS_ALERT_WEBHOOK_URL: "https://ops.example.test/reward-alerts",
  REWARDS_CAMPAIGN_CHAIN_ID: "84532",
  REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS: "0x1000000000000000000000000000000000000001",
  REWARDS_CAMPAIGN_TREASURY_ADDRESS: "0x2000000000000000000000000000000000000002",
  REWARDS_CAMPAIGN_RPC_URL: "https://base-sepolia.example.test",
  REWARDS_CAMPAIGN_QUOTE_TTL_SECONDS: "900",
  REWARDS_CAMPAIGN_MIN_BUDGET_CENTS: "1000",
  REWARDS_CAMPAIGN_MAX_BUDGET_CENTS: "1000000",
  REWARDS_CAMPAIGN_MAX_REWARD_CENTS: "1000",
  REWARDS_CAMPAIGN_MIN_DURATION_SECONDS: "3600",
  REWARDS_CAMPAIGN_MAX_DURATION_SECONDS: "7776000",
} as unknown as Env

const CONFIRMED_BLOCK_HASH = `0x${"1".repeat(64)}`
const REPLACED_BLOCK_HASH = `0x${"2".repeat(64)}`
const HEALTHY_FINALITY_PROVIDER: RewardCampaignFinalityProvider = {
  send: async () => "0x14a34",
  getTransactionReceipt: async () => ({ blockNumber: 123, blockHash: CONFIRMED_BLOCK_HASH }),
  getBlock: async () => ({ hash: CONFIRMED_BLOCK_HASH }),
}
const REORGED_FINALITY_PROVIDER: RewardCampaignFinalityProvider = {
  send: async () => "0x14a34",
  getTransactionReceipt: async () => null,
  getBlock: async () => ({ hash: REPLACED_BLOCK_HASH }),
}
const TRANSIENT_FINALITY_PROVIDER: RewardCampaignFinalityProvider = {
  send: async () => "0x14a34",
  getTransactionReceipt: async () => { throw new Error("rpc unavailable") },
  getBlock: async () => { throw new Error("rpc unavailable") },
}
const PARTIAL_FINALITY_PROVIDER: RewardCampaignFinalityProvider = {
  send: async () => "0x14a34",
  getTransactionReceipt: async (txHash) => {
    if (txHash === `0x${"a".repeat(64)}`) throw new Error("receipt endpoint unavailable for one effect")
    return { blockNumber: 123, blockHash: CONFIRMED_BLOCK_HASH }
  },
  getBlock: async () => ({ hash: CONFIRMED_BLOCK_HASH }),
}

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
      CREATE TABLE communities (
        community_id TEXT PRIMARY KEY
      );
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
        activated_at TEXT,
        exhausted_at TEXT,
        ended_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
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
      CREATE TABLE reward_qualification_events (
        reward_qualification_event_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        community_id TEXT NOT NULL,
        post_id TEXT NOT NULL,
        activity TEXT NOT NULL,
        qualified_at TIMESTAMPTZ NOT NULL,
        reward_period_key TEXT NOT NULL,
        score_bps INTEGER,
        source_event_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        last_error TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE reward_pending_qualifications (
        reward_pending_qualification_id TEXT PRIMARY KEY,
        reward_qualification_event_id TEXT NOT NULL UNIQUE,
        reward_campaign_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        community_id TEXT NOT NULL,
        post_id TEXT NOT NULL,
        reward_period_key TEXT NOT NULL,
        reward_kind TEXT NOT NULL,
        qualification_basis TEXT NOT NULL,
        conditional_amount_cents INTEGER NOT NULL,
        status TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        terminal_reason TEXT,
        credited_reward_event_id TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
    `)
    await db.unsafe(await readFile(SONG_PERIOD_CLAIMS_MIGRATION_URL, "utf8"))
    await db.unsafe(await readFile(INVARIANTS_MIGRATION_URL, "utf8"))
    await db.unsafe(await readFile(SCORE_TERMS_MIGRATION_URL, "utf8"))
    await db.unsafe(await readFile(PAYOUT_EFFECTS_MIGRATION_URL, "utf8"))
    await db.unsafe(await readFile(SONG_SLOTS_MIGRATION_URL, "utf8"))
    await db.unsafe(`
      CREATE TABLE reward_campaign_funding_effects (
        reward_campaign_funding_effect_id TEXT PRIMARY KEY, reward_campaign_id TEXT NOT NULL,
        tx_hash TEXT, status TEXT NOT NULL, chain_id INTEGER NOT NULL DEFAULT 84532,
        expected_amount_cents INTEGER NOT NULL,
        confirmed_block_number BIGINT, confirmed_block_hash TEXT, confirmed_at TEXT
      );
    `)
    const concurrentPoolsMigration = await readFile(CONCURRENT_POOLS_MIGRATION_URL, "utf8")
    await db.unsafe(concurrentPoolsMigration.replaceAll("TIMESTAMPTZ", "TEXT"))
    await db.unsafe(await readFile(NATIONALITY_TIERS_MIGRATION_URL, "utf8"))
    // Legacy campaign fixtures in this broad harness predate tier terms and
    // intentionally omit them. Preserve the prior harness default without
    // mirroring or modifying any 0189 constraint under test.
    await db.unsafe(`ALTER TABLE reward_campaigns
      ALTER COLUMN default_amount_cents SET DEFAULT 40,
      ALTER COLUMN max_claim_cents SET DEFAULT 40`)
    await db.unsafe(await readFile(IDENTITY_PROVIDER_MIGRATION_URL, "utf8"))
    await db.unsafe(`
      CREATE TABLE user_attestations (
        user_attestation_id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        source_verification_session_id TEXT, provider TEXT NOT NULL,
        attestation_type TEXT NOT NULL, capability_key TEXT NOT NULL,
        status TEXT NOT NULL, value_json JSONB NOT NULL, verified_at TEXT NOT NULL,
        revoked_at TEXT, source_identity_nullifier_id TEXT
      );
      CREATE TABLE reward_identity_bindings (
        reward_identity_binding_id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
        identity_nullifier_id TEXT NOT NULL, status TEXT NOT NULL,
        selected_at TEXT NOT NULL, superseded_at TEXT
      );
      CREATE TABLE reward_claim_identity_evidence (
        reward_claim_identity_evidence_id TEXT PRIMARY KEY
      );
    `)
    await db.unsafe(await readFile(NATIONALITY_DECISIONS_MIGRATION_URL, "utf8"))
    // Reproduce legacy rows that caused the first staging 0189 attempt to fail.
    // These were written by the pre-accounting evaluator. Migration 0189
    // must derive their amounts from immutable campaign terms before installing
    // the resolved-amount constraint.
    await db.unsafe(`
      INSERT INTO users VALUES ('usr_legacy_0189', '{}'::jsonb);
      INSERT INTO communities VALUES ('cmt_legacy_0189');
      INSERT INTO reward_campaigns (
        reward_campaign_id, rewarder_user_id, creation_idempotency_key,
        community_id, post_id, song_artifact_bundle_id, song_owner_user_id,
        status, eligible_activity, daily_reward_cents, reward_period_cap_cents,
        budget_cents, funded_cents, reserved_cents, credited_cents, paid_cents,
        refunded_cents, terms_version, terms_hash, starts_at, ends_at, updated_at,
        default_amount_cents, max_claim_cents, payout_tiers_json,
        reward_identity_provider
      ) VALUES (
        'rcp_legacy_0189', 'usr_legacy_0189', 'create-legacy-0189',
        'cmt_legacy_0189', 'pst_legacy_0189', 'sab_legacy_0189', 'usr_legacy_0189',
        'active', 'study', 25, 75, 100, 100, 0, 0, 0, 0, 1,
        'terms-legacy-0189', '2026-07-01T00:00:00.000Z',
        '2026-07-31T23:59:59.999Z', '${NOW}', 25, 75,
        '[{"nationalities":["VN"],"amount_cents":75}]'::jsonb, 'self'
      );
      INSERT INTO reward_qualification_events (
        reward_qualification_event_id, user_id, community_id, post_id,
        activity, qualified_at, reward_period_key, source_event_id, status,
        created_at, updated_at
      ) VALUES
        ('rqe_legacy_default_0189', 'usr_legacy_0189', 'cmt_legacy_0189',
          'pst_legacy_0189', 'study', '${NOW}', '2026-07-10',
          'source-legacy-default-0189', 'pending', '${NOW}', '${NOW}'),
        ('rqe_legacy_tier_0189', 'usr_legacy_0189', 'cmt_legacy_0189',
          'pst_legacy_0189', 'study', '${NOW}', '2026-07-10',
          'source-legacy-tier-0189', 'pending', '${NOW}', '${NOW}');
      INSERT INTO reward_nationality_decisions (
        reward_nationality_decision_id, reward_qualification_event_id,
        reward_campaign_id, user_id, result_key, outcome, retryability,
        campaign_terms_version, evaluator_version, evaluated_at, expires_at,
        created_at
      ) VALUES
        ('rnd_legacy_default_0189', 'rqe_legacy_default_0189',
          'rcp_legacy_0189', 'usr_legacy_0189', 'default', 'resolved_default',
          'resolved', 1, 'legacy-v1', '${NOW}', '2027-01-01T00:00:00.000Z', '${NOW}'),
        ('rnd_legacy_tier_0189', 'rqe_legacy_tier_0189',
          'rcp_legacy_0189', 'usr_legacy_0189', 'tier:0', 'resolved_tier',
          'resolved', 1, 'legacy-v1', '${NOW}', '2027-01-01T00:00:00.000Z', '${NOW}');
    `)
    await db.unsafe(await readFile(TIER_ACCOUNTING_MIGRATION_URL, "utf8"))
    await db.unsafe(`
      ALTER TABLE reward_campaigns
        ADD COLUMN status_before_operational_hold TEXT,
        ADD COLUMN operational_hold_reason TEXT,
        ADD COLUMN operational_held_at TIMESTAMPTZ,
        ADD COLUMN operational_held_by TEXT,
        ADD COLUMN operational_recovered_at TIMESTAMPTZ,
        ADD COLUMN operational_recovered_by TEXT;
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
        monitor_name TEXT PRIMARY KEY,
        first_attempted_scan_at TIMESTAMPTZ NOT NULL,
        last_attempted_scan_at TIMESTAMPTZ NOT NULL,
        last_successful_scan_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL
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
    await db.unsafe(`INSERT INTO communities VALUES ('cmt_reward_pg')`)
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
        'rcp_sequential_study_pg', 'usr_reward_pg', 'create-sequential-study-pg', 'cmt_reward_pg',
        'pst_sequential_pg', 'sab_sequential_pg', 'usr_reward_pg', 'ended', 'study',
        40, 40, 100, 100, 0, 0, 0, 0, 1, 'terms-sequential-study-pg',
        '2026-07-10T00:00:00.000Z', '2026-07-10T11:59:59.999Z', $1
      ),
      (
        'rcp_sequential_karaoke_pg', 'usr_reward_pg', 'create-sequential-karaoke-pg', 'cmt_reward_pg',
        'pst_sequential_pg', 'sab_sequential_pg', 'usr_reward_pg', 'active', 'karaoke',
        40, 40, 100, 100, 0, 0, 0, 0, 1, 'terms-sequential-karaoke-pg',
        '2026-07-10T12:00:00.000Z', '2026-07-10T23:59:59.999Z', $1
      ),
      (
        'rcp_cross_race_study_pg', 'usr_reward_pg', 'create-cross-race-study-pg', 'cmt_reward_pg',
        'pst_cross_race_pg', 'sab_cross_race_pg', 'usr_reward_pg', 'ended', 'study',
        40, 40, 100, 100, 0, 0, 0, 0, 1, 'terms-cross-race-study-pg',
        '2026-07-10T00:00:00.000Z', '2026-07-10T11:59:59.999Z', $1
      ),
      (
        'rcp_cross_race_karaoke_pg', 'usr_reward_pg', 'create-cross-race-karaoke-pg', 'cmt_reward_pg',
        'pst_cross_race_pg', 'sab_cross_race_pg', 'usr_reward_pg', 'active', 'karaoke',
        40, 40, 100, 100, 0, 0, 0, 0, 1, 'terms-cross-race-karaoke-pg',
        '2026-07-10T12:00:00.000Z', '2026-07-10T23:59:59.999Z', $1
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
    await db.unsafe(`
      INSERT INTO reward_campaign_funding_effects (
        reward_campaign_funding_effect_id, reward_campaign_id, status,
        expected_amount_cents, confirmed_at
      )
      SELECT
        'rcf_seed_' || reward_campaign_id,
        reward_campaign_id,
        'confirmed',
        funded_cents,
        $1
      FROM reward_campaigns
      WHERE funded_cents > 0
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

  async function removeCampaignTestPost(postId: string): Promise<void> {
    const db = connect(TEST_DB, 1)
    await db.unsafe("DELETE FROM reward_song_period_claims WHERE post_id = $1", [postId])
    await db.unsafe("DELETE FROM reward_events WHERE post_id = $1", [postId])
    await db.unsafe("DELETE FROM reward_song_pools WHERE post_id = $1", [postId])
    await db.unsafe(`
      DELETE FROM reward_campaign_reservation_funding_allocations a
      USING reward_campaign_reservations r, reward_campaigns c
      WHERE a.reward_campaign_reservation_id = r.reward_campaign_reservation_id
        AND c.reward_campaign_id = r.reward_campaign_id
        AND c.post_id = $1
    `, [postId])
    await db.unsafe(`
      DELETE FROM reward_campaign_reservations r
      USING reward_campaigns c
      WHERE c.reward_campaign_id = r.reward_campaign_id AND c.post_id = $1
    `, [postId])
    await db.unsafe("DELETE FROM reward_campaigns WHERE post_id = $1", [postId])
    await db.end()
  }

  test("concurrent song-pool registration admits one stable pool identity", async () => {
    const seed = connect(TEST_DB, 1)
    await seed.unsafe(`
      INSERT INTO reward_campaigns (
        reward_campaign_id, rewarder_user_id, creation_idempotency_key,
        community_id, post_id, song_artifact_bundle_id, song_owner_user_id,
        status, eligible_activity, min_score_bps, daily_reward_cents,
        milestone_7_cents, milestone_30_cents, reward_period_cap_cents,
        budget_cents, funded_cents, reserved_cents, credited_cents, paid_cents,
        refunded_cents, terms_version, terms_hash, starts_at, ends_at, updated_at
      ) VALUES
        ('rcp_slot_a_pg', 'usr_reward_pg', 'slot-a', 'cmt_reward_pg', 'pst_slot_pg',
          'sab_slot_pg', 'usr_reward_pg', 'draft', 'karaoke', 7000, 40, 0, 0, 40,
          100, 0, 0, 0, 0, 0, 2, 'slot-a', $1, $2, $1),
        ('rcp_slot_b_pg', 'usr_reward_pg', 'slot-b', 'cmt_reward_pg', 'pst_slot_pg',
          'sab_slot_pg', 'usr_reward_pg', 'draft', 'karaoke', 7000, 40, 0, 0, 40,
          100, 0, 0, 0, 0, 0, 2, 'slot-b', $1, $2, $1)
    `, [NOW, "2026-07-11T12:00:00.000Z"])
    try {
      await withProductionPostgresClient(async (client) => {
        const register = (campaignId: string) => client.execute({
          sql: REWARD_SONG_POOL_REGISTER_SQL,
          args: ["cmt_reward_pg", "pst_slot_pg", campaignId, NOW],
        })
        const attempts = await Promise.all([
          register("rcp_slot_a_pg"),
          register("rcp_slot_b_pg"),
        ])
        expect(attempts.reduce((count, result) => count + result.rows.length, 0)).toBe(1)
        const held = await client.execute("SELECT reward_campaign_id FROM reward_song_pools WHERE post_id = 'pst_slot_pg'")
        const holder = String(held.rows[0]?.reward_campaign_id)
        const other = holder === "rcp_slot_a_pg" ? "rcp_slot_b_pg" : "rcp_slot_a_pg"

        await client.execute({ sql: "UPDATE reward_campaigns SET status = 'ended' WHERE reward_campaign_id = ?1", args: [holder] })
        await client.execute({ sql: "DELETE FROM reward_song_pools WHERE reward_campaign_id = ?1", args: [holder] })
        const replacement = await register(other)
        expect(replacement.rows).toEqual([{ reward_campaign_id: other }])
      })
    } finally {
      await seed.end()
    }
  })

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
    const allocations = await verify.unsafe(`
      SELECT a.amount_cents, f.reward_campaign_funding_effect_id
      FROM reward_campaign_reservation_funding_allocations a
      JOIN reward_campaign_funding_effects f
        ON f.reward_campaign_funding_effect_id = a.reward_campaign_funding_effect_id
    `) as Array<{ amount_cents: number; reward_campaign_funding_effect_id: string }>
    await verify.end()
    expect(reservations).toEqual([{ status: "credited", amount_cents: 40 }])
    expect(events).toEqual([{ amount_cents: 40 }])
    expect(campaigns).toEqual([{ funded_cents: 100, reserved_cents: 0, credited_cents: 40 }])
    expect(allocations).toEqual([{
      amount_cents: 40,
      reward_campaign_funding_effect_id: "rcf_seed_rcp_reward_pg",
    }])
  })

  test("mixed-tier claimants concurrently reserve exact amounts without crossing funded lots", async () => {
    const seed = connect(TEST_DB, 1)
    for (const claimant of [
      { suffix: "vn", nationality: "VNM", amount: 60 },
      { suffix: "us", nationality: "USA", amount: 80 },
    ]) {
      await seed.unsafe(`INSERT INTO users VALUES ($1, $2)`, [
        `usr_tier_${claimant.suffix}`,
        JSON.stringify({ unique_human: { state: "verified", provider: "self",
          mechanism: "passport", verified_at: NOW } }),
      ])
      await seed.unsafe(`INSERT INTO identity_nullifiers VALUES (
        $1, $2, 'self', 'passport', $3, 'active', $4
      )`, [`idn_tier_${claimant.suffix}`, `usr_tier_${claimant.suffix}`,
        `tier-${claimant.suffix}-nullifier`, NOW])
      await seed.unsafe(`INSERT INTO reward_identity_bindings VALUES (
        $1, $2, $3, 'active', $4, NULL
      )`, [`rib_tier_${claimant.suffix}`, `usr_tier_${claimant.suffix}`,
        `idn_tier_${claimant.suffix}`, NOW])
      await seed.unsafe(`INSERT INTO user_attestations VALUES (
        $1, $2, NULL, 'self', 'nationality', 'nationality', 'accepted',
        $3::jsonb, $4, NULL, $5
      )`, [`att_tier_${claimant.suffix}`, `usr_tier_${claimant.suffix}`,
        JSON.stringify({ nationality: claimant.nationality }), NOW,
        `idn_tier_${claimant.suffix}`])
      await seed.unsafe(`INSERT INTO reward_qualification_events (
        reward_qualification_event_id, user_id, community_id, post_id,
        activity, qualified_at, reward_period_key, source_event_id, status,
        created_at, updated_at
      ) VALUES ($1, $2, 'cmt_reward_pg', 'pst_tier_pg', 'study', $3,
        '2026-07-10', $1, 'pending', $3, $3)`, [
        `rqe_tier_${claimant.suffix}`, `usr_tier_${claimant.suffix}`, NOW,
      ])
    }
    await seed.unsafe(`INSERT INTO reward_campaigns (
      reward_campaign_id, rewarder_user_id, creation_idempotency_key,
      community_id, post_id, song_artifact_bundle_id, song_owner_user_id,
      status, eligible_activity, daily_reward_cents, default_amount_cents,
      max_claim_cents, payout_tiers_json, reward_period_cap_cents,
      budget_cents, funded_cents, reserved_cents, credited_cents, paid_cents,
      refunded_cents, terms_version, terms_hash, starts_at, ends_at, updated_at
    ) VALUES (
      'rcp_tier_pg', 'usr_reward_pg', 'tier-pg', 'cmt_reward_pg', 'pst_tier_pg',
      'sab_tier_pg', 'usr_reward_pg', 'active', 'study', 40, 40, 80,
      '[{"nationalities":["VNM"],"amount_cents":60},{"nationalities":["USA"],"amount_cents":80}]',
      80, 140, 140, 0, 0, 0, 0, 4, 'terms-tier-pg',
      '2026-07-01T00:00:00.000Z', '2026-07-31T23:59:59.999Z', $1
    )`, [NOW])
    for (const suffix of ["a", "b"]) {
      await seed.unsafe(`INSERT INTO reward_campaign_funding_effects (
        reward_campaign_funding_effect_id, reward_campaign_id, status,
        expected_amount_cents, confirmed_at
      ) VALUES ($1, 'rcp_tier_pg', 'confirmed', 70, $2)`, [`rcf_tier_${suffix}`, NOW])
    }
    await seed.end()

    await withProductionPostgresClient(async (client) => {
      const results = await Promise.all(["vn", "us"].map((suffix) =>
        creditRewardCampaignQualification({
          env: PG_ENV,
          client,
          now: NOW,
          candidate: {
            eventId: `rqe_tier_${suffix}`,
            userId: `usr_tier_${suffix}`,
            communityId: "cmt_reward_pg",
            postId: "pst_tier_pg",
            artifactBundleId: "sab_tier_pg",
            activity: "study",
            qualifiedAt: NOW,
            periodKey: "2026-07-10",
            policyVersion: "study-completed-set-v1",
          },
        })
      ))
      expect(results.map((result) => result.amountCents).sort()).toEqual([60, 80])
      const invariant = await client.execute(`SELECT
        c.funded_cents, c.reserved_cents, c.credited_cents, c.refunded_cents,
        (SELECT SUM(a.amount_cents) FROM reward_campaign_reservation_funding_allocations a
          JOIN reward_campaign_reservations r USING (reward_campaign_reservation_id)
          WHERE r.reward_campaign_id = c.reward_campaign_id) AS allocated_cents,
        (SELECT COUNT(*) FROM reward_pending_qualification_funding_exposures e
          WHERE e.reward_campaign_id = c.reward_campaign_id) AS pending_exposures
        FROM reward_campaigns c WHERE c.reward_campaign_id = 'rcp_tier_pg'`)
      const row = invariant.rows[0]!
      expect(Number(row.funded_cents)).toBe(140)
      expect(Number(row.reserved_cents) + Number(row.credited_cents)
        + Number(row.refunded_cents)).toBeLessThanOrEqual(Number(row.funded_cents))
      expect(Number(row.credited_cents)).toBe(140)
      expect(Number(row.allocated_cents)).toBe(140)
      expect(Number(row.pending_exposures)).toBe(0)
    })
  })

  test("serializes concurrent unresolved tier exposure under the campaign row lock", async () => {
    const seed = connect(TEST_DB, 1)
    for (const suffix of ["a", "b"]) {
      await seed.unsafe(`INSERT INTO users VALUES ($1, $2)`, [
        `usr_pending_tier_${suffix}`,
        JSON.stringify({ unique_human: { state: "verified", provider: "self",
          mechanism: "passport", verified_at: NOW } }),
      ])
      await seed.unsafe(`INSERT INTO identity_nullifiers VALUES (
        $1, $2, 'self', 'passport', $3, 'active', $4
      )`, [`idn_pending_tier_${suffix}`, `usr_pending_tier_${suffix}`,
        `pending-tier-${suffix}-nullifier`, NOW])
      await seed.unsafe(`INSERT INTO reward_identity_bindings VALUES (
        $1, $2, $3, 'active', $4, NULL
      )`, [`rib_pending_tier_${suffix}`, `usr_pending_tier_${suffix}`,
        `idn_pending_tier_${suffix}`, NOW])
      await seed.unsafe(`INSERT INTO reward_qualification_events (
        reward_qualification_event_id, user_id, community_id, post_id,
        activity, qualified_at, reward_period_key, source_event_id, status,
        created_at, updated_at
      ) VALUES ($1, $2, 'cmt_reward_pg', 'pst_pending_tier_pg', 'study', $3,
        '2026-07-10', $1, 'pending', $3, $3)`, [
        `rqe_pending_tier_${suffix}`, `usr_pending_tier_${suffix}`, NOW,
      ])
    }
    await seed.unsafe(`INSERT INTO reward_campaigns (
      reward_campaign_id, rewarder_user_id, creation_idempotency_key,
      community_id, post_id, song_artifact_bundle_id, song_owner_user_id,
      status, eligible_activity, daily_reward_cents, default_amount_cents,
      max_claim_cents, payout_tiers_json, reward_period_cap_cents,
      budget_cents, funded_cents, reserved_cents, credited_cents, paid_cents,
      refunded_cents, terms_version, terms_hash, starts_at, ends_at, updated_at
    ) VALUES (
      'rcp_pending_tier_pg', 'usr_reward_pg', 'pending-tier-pg',
      'cmt_reward_pg', 'pst_pending_tier_pg', 'sab_pending_tier_pg',
      'usr_reward_pg', 'active', 'study', 40, 40, 80,
      '[{"nationalities":["USA"],"amount_cents":80}]',
      80, 100, 100, 0, 0, 0, 0, 4, 'terms-pending-tier-pg',
      '2026-07-01T00:00:00.000Z', '2026-07-31T23:59:59.999Z', $1
    )`, [NOW])
    await seed.unsafe(`INSERT INTO reward_campaign_funding_effects (
      reward_campaign_funding_effect_id, reward_campaign_id, status,
      expected_amount_cents, confirmed_at
    ) VALUES ('rcf_pending_tier_pg', 'rcp_pending_tier_pg', 'confirmed', 100, $1)`, [NOW])
    await seed.end()

    await withProductionPostgresClient(async (client) => {
      const results = await Promise.all(["a", "b"].map((suffix) =>
        creditRewardCampaignQualification({
          env: PG_ENV, client, now: NOW,
          candidate: {
            eventId: `rqe_pending_tier_${suffix}`,
            userId: `usr_pending_tier_${suffix}`,
            communityId: "cmt_reward_pg",
            postId: "pst_pending_tier_pg",
            artifactBundleId: "sab_pending_tier_pg",
            activity: "study",
            qualifiedAt: NOW,
            periodKey: "2026-07-10",
            policyVersion: "study-completed-set-v1",
          },
        })
      ))
      expect(results.map((result) => result.result).sort()).toEqual(["funding_deferred", "identity"])
      const exposure = await client.execute(`SELECT
        COALESCE(SUM(amount_cents), 0) AS exposed_cents, COUNT(*) AS exposure_rows
        FROM reward_pending_qualification_funding_exposures
        WHERE reward_campaign_id = 'rcp_pending_tier_pg'`)
      expect(Number(exposure.rows[0]?.exposed_cents)).toBe(80)
      expect(Number(exposure.rows[0]?.exposure_rows)).toBe(1)
    })
  })

  test("does not expose lots before the campaign provider verifies a unique human", async () => {
    const seed = connect(TEST_DB, 1)
    await seed.unsafe(`INSERT INTO users VALUES ('usr_unverified_tier', '{}')`)
    await seed.unsafe(`INSERT INTO reward_qualification_events (
      reward_qualification_event_id, user_id, community_id, post_id,
      activity, qualified_at, reward_period_key, source_event_id, status,
      created_at, updated_at
    ) VALUES ('rqe_unverified_tier', 'usr_unverified_tier', 'cmt_reward_pg',
      'pst_unverified_tier', 'study', $1, '2026-07-10',
      'rqe_unverified_tier', 'pending', $1, $1)`, [NOW])
    await seed.unsafe(`INSERT INTO reward_campaigns (
      reward_campaign_id, rewarder_user_id, creation_idempotency_key,
      community_id, post_id, song_artifact_bundle_id, song_owner_user_id,
      status, eligible_activity, daily_reward_cents, default_amount_cents,
      max_claim_cents, payout_tiers_json, reward_period_cap_cents,
      budget_cents, funded_cents, reserved_cents, credited_cents, paid_cents,
      refunded_cents, terms_version, terms_hash, starts_at, ends_at, updated_at
    ) VALUES ('rcp_unverified_tier', 'usr_reward_pg', 'unverified-tier',
      'cmt_reward_pg', 'pst_unverified_tier', 'sab_unverified_tier',
      'usr_reward_pg', 'active', 'study', 40, 40, 80,
      '[{"nationalities":["USA"],"amount_cents":80}]', 80,
      100, 100, 0, 0, 0, 0, 4, 'terms-unverified-tier',
      '2026-07-01T00:00:00.000Z', '2026-07-31T23:59:59.999Z', $1)`, [NOW])
    await seed.unsafe(`INSERT INTO reward_campaign_funding_effects (
      reward_campaign_funding_effect_id, reward_campaign_id, status,
      expected_amount_cents, confirmed_at
    ) VALUES ('rcf_unverified_tier', 'rcp_unverified_tier', 'confirmed', 100, $1)`, [NOW])
    await seed.end()

    await withProductionPostgresClient(async (client) => {
      const result = await creditRewardCampaignQualification({
        env: PG_ENV, client, now: NOW,
        candidate: {
          eventId: "rqe_unverified_tier", userId: "usr_unverified_tier",
          communityId: "cmt_reward_pg", postId: "pst_unverified_tier",
          artifactBundleId: "sab_unverified_tier", activity: "study",
          qualifiedAt: NOW, periodKey: "2026-07-10",
          policyVersion: "study-completed-set-v1",
        },
      })
      expect(result).toEqual({ result: "identity", amountCents: 0 })
      const state = await client.execute(`SELECT
        p.exposure_amount_cents,
        (SELECT COUNT(*) FROM reward_pending_qualification_funding_exposures e
          WHERE e.reward_pending_qualification_id = p.reward_pending_qualification_id) AS exposure_rows
        FROM reward_pending_qualifications p
        WHERE p.reward_qualification_event_id = 'rqe_unverified_tier'`)
      expect(state.rows[0]).toEqual({ exposure_amount_cents: null, exposure_rows: "0" })
    })
  })

  test("expiry releases pending exposure and canonical cascade covers row deletion", async () => {
    const db = connect(TEST_DB, 1)
    await db.unsafe(`UPDATE reward_pending_qualifications
      SET expires_at = '2026-07-09T00:00:00.000Z'
      WHERE reward_pending_qualification_id IN (
        SELECT reward_pending_qualification_id
        FROM reward_pending_qualification_funding_exposures
        WHERE reward_campaign_id = 'rcp_pending_tier_pg'
      )`)
    await db.end()
    await withProductionPostgresClient(async (client) => {
      await expirePendingRewardQualifications({ client, now: NOW })
      const expired = await client.execute(`SELECT p.status,
        (SELECT COUNT(*) FROM reward_pending_qualification_funding_exposures e
          WHERE e.reward_pending_qualification_id = p.reward_pending_qualification_id) AS exposure_rows
        FROM reward_pending_qualifications p
        WHERE p.status = 'expired' AND p.reward_campaign_id = 'rcp_pending_tier_pg'`)
      expect(expired.rows[0]).toEqual({ status: "expired", exposure_rows: "0" })
      await client.execute({
        sql: `INSERT INTO reward_pending_qualification_funding_exposures (
          reward_pending_qualification_id, reward_campaign_id,
          reward_campaign_funding_effect_id, amount_cents, exposed_at
        ) SELECT p.reward_pending_qualification_id, p.reward_campaign_id,
          'rcf_pending_tier_pg', 1, ?1
          FROM reward_pending_qualifications p
          WHERE p.reward_campaign_id = 'rcp_pending_tier_pg' AND p.status <> 'expired'
          LIMIT 1`,
        args: [NOW],
      })
      await client.execute(`DELETE FROM reward_pending_qualifications
        WHERE reward_campaign_id = 'rcp_pending_tier_pg' AND status <> 'expired'`)
      const cascaded = await client.execute(`SELECT COUNT(*) AS count
        FROM reward_pending_qualification_funding_exposures
        WHERE reward_campaign_id = 'rcp_pending_tier_pg'`)
      expect(Number(cascaded.rows[0]?.count)).toBe(0)
    })
  })

  test("uses the permanent pool provider and fails closed for another provider", async () => {
    const seed = connect(TEST_DB, 1)
    await seed.unsafe(`
      INSERT INTO reward_campaigns (
        reward_campaign_id, rewarder_user_id, creation_idempotency_key,
        community_id, post_id, song_artifact_bundle_id, song_owner_user_id,
        reward_identity_provider, status, eligible_activity, min_score_bps,
        daily_reward_cents, milestone_7_cents, milestone_30_cents,
        reward_period_cap_cents, budget_cents, funded_cents, reserved_cents,
        credited_cents, paid_cents, refunded_cents, terms_version, terms_hash,
        starts_at, ends_at, updated_at
      ) VALUES (
        'rcp_provider_mismatch_pg', 'usr_reward_pg', 'provider-mismatch-pg',
        'cmt_reward_pg', 'pst_provider_mismatch_pg', 'sab_provider_mismatch_pg',
        'usr_reward_pg', 'zkpassport', 'active', 'study', 7000, 40, 0, 0,
        40, 100, 100, 0, 0, 0, 0, 4, 'provider-mismatch-terms',
        '2026-07-01T00:00:00.000Z', '2026-07-31T23:59:59.999Z', $1
      )
    `, [NOW])
    await seed.unsafe(`
      INSERT INTO reward_song_pools (
        community_id, post_id, reward_campaign_id, created_at, updated_at
      ) VALUES (
        'cmt_reward_pg', 'pst_provider_mismatch_pg',
        'rcp_provider_mismatch_pg', $1, $1
      )
    `, [NOW])
    await seed.end()
    try {
      await withProductionPostgresClient(async (client) => {
        const result = await creditRewardCampaignQualification({
          env: PG_ENV,
          client,
          now: NOW,
          candidate: {
            eventId: "rqe_provider_mismatch_pg",
            userId: "usr_reward_pg",
            communityId: "cmt_reward_pg",
            postId: "pst_provider_mismatch_pg",
            artifactBundleId: "sab_provider_mismatch_pg",
            activity: "study",
            qualifiedAt: NOW,
            periodKey: "2026-07-10",
            policyVersion: "study-completed-set-v1",
          },
        })
        expect(result).toEqual({ result: "identity", amountCents: 0 })
        const accounting = await client.execute(`
          SELECT
            (SELECT COUNT(*)::int FROM reward_campaign_reservations
              WHERE reward_campaign_id = 'rcp_provider_mismatch_pg') AS reservations,
            (SELECT COUNT(*)::int FROM reward_events
              WHERE reward_campaign_id = 'rcp_provider_mismatch_pg') AS events
        `)
        expect(accounting.rows[0]).toEqual({ reservations: 0, events: 0 })
      })
    } finally {
      await removeCampaignTestPost("pst_provider_mismatch_pg")
    }
  })

  test("a later campaign cannot pay the other activity for the same human, song, and UTC day", async () => {
    const results = await withProductionPostgresClient(async (client) => {
      const study = await creditRewardCampaignQualification({
        env: PG_ENV,
        client,
        candidate: {
          eventId: "rqe_sequential_study_pg",
          userId: "usr_reward_pg",
          communityId: "cmt_reward_pg",
          postId: "pst_sequential_pg",
          artifactBundleId: "sab_sequential_pg",
          activity: "study",
          qualifiedAt: "2026-07-10T10:00:00.000Z",
          periodKey: "2026-07-10",
          policyVersion: "study-completed-set-v1",
        },
        now: "2026-07-10T13:00:00.000Z",
      })
      const karaoke = await creditRewardCampaignQualification({
        env: PG_ENV,
        client,
        candidate: {
          eventId: "rqe_sequential_karaoke_pg",
          userId: "usr_reward_pg",
          communityId: "cmt_reward_pg",
          postId: "pst_sequential_pg",
          artifactBundleId: "sab_sequential_pg",
          activity: "karaoke",
          finalScoreBps: 8000,
          qualifiedAt: "2026-07-10T13:00:00.000Z",
          periodKey: "2026-07-10",
          policyVersion: "karaoke-rank-eligible-v1",
        },
        now: "2026-07-10T13:00:00.000Z",
      })
      return [study, karaoke]
    })
    expect(results.map((result) => result.result)).toEqual(["credited", "duplicate"])

    const verify = connect(TEST_DB, 1)
    const claims = await verify.unsafe(`
      SELECT song_artifact_bundle_id, reward_kind
      FROM reward_song_period_claims
      WHERE community_id = 'cmt_reward_pg' AND post_id = 'pst_sequential_pg'
    `) as Array<{ song_artifact_bundle_id: string; reward_kind: string }>
    const reservations = await verify.unsafe(`
      SELECT reward_campaign_id, qualification_basis
      FROM reward_campaign_reservations
      WHERE reward_campaign_id IN ('rcp_sequential_study_pg', 'rcp_sequential_karaoke_pg')
    `) as Array<{ reward_campaign_id: string; qualification_basis: string }>
    const laterCampaign = await verify.unsafe(`
      SELECT reserved_cents, credited_cents
      FROM reward_campaigns
      WHERE reward_campaign_id = 'rcp_sequential_karaoke_pg'
    `) as Array<{ reserved_cents: number; credited_cents: number }>
    await verify.end()
    expect(claims).toEqual([{ song_artifact_bundle_id: "sab_sequential_pg", reward_kind: "campaign_practice_day" }])
    expect(reservations).toEqual([{ reward_campaign_id: "rcp_sequential_study_pg", qualification_basis: "study" }])
    expect(laterCampaign).toEqual([{ reserved_cents: 0, credited_cents: 0 }])
    await removeCampaignTestPost("pst_sequential_pg")
  })

  test("song-scoped uniqueness resolves qualifications racing across campaign row locks", async () => {
    const results = await withProductionPostgresClient(async (client) => Promise.all([
      creditRewardCampaignQualification({
        env: PG_ENV,
        client,
        candidate: {
          eventId: "rqe_cross_race_study_pg",
          userId: "usr_reward_pg",
          communityId: "cmt_reward_pg",
          postId: "pst_cross_race_pg",
          artifactBundleId: "sab_cross_race_pg",
          activity: "study",
          qualifiedAt: "2026-07-10T10:00:00.000Z",
          periodKey: "2026-07-10",
          policyVersion: "study-completed-set-v1",
        },
        now: "2026-07-10T13:00:00.000Z",
      }),
      creditRewardCampaignQualification({
        env: PG_ENV,
        client,
        candidate: {
          eventId: "rqe_cross_race_karaoke_pg",
          userId: "usr_reward_pg",
          communityId: "cmt_reward_pg",
          postId: "pst_cross_race_pg",
          artifactBundleId: "sab_cross_race_pg",
          activity: "karaoke",
          finalScoreBps: 8000,
          qualifiedAt: "2026-07-10T13:00:00.000Z",
          periodKey: "2026-07-10",
          policyVersion: "karaoke-rank-eligible-v1",
        },
        now: "2026-07-10T13:00:00.000Z",
      }),
    ]))
    expect(results.map((result) => result.result).sort()).toEqual(["credited", "duplicate"])

    const verify = connect(TEST_DB, 1)
    const counts = await verify.unsafe(`
      SELECT
        (SELECT COUNT(*)::int FROM reward_song_period_claims WHERE post_id = 'pst_cross_race_pg') AS claims,
        (SELECT COUNT(*)::int FROM reward_campaign_reservations r
          JOIN reward_campaigns c ON c.reward_campaign_id = r.reward_campaign_id
          WHERE c.post_id = 'pst_cross_race_pg') AS reservations,
        (SELECT COUNT(*)::int FROM reward_events WHERE post_id = 'pst_cross_race_pg') AS events
    `) as Array<{ claims: number; reservations: number; events: number }>
    await verify.end()
    expect(counts).toEqual([{ claims: 1, reservations: 1, events: 1 }])
    await removeCampaignTestPost("pst_cross_race_pg")
  })

  test("different identities racing for the final funding leave the loser retryable", async () => {
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
    expect(results.map((result) => result.result).sort()).toEqual(["credited", "funding_deferred"])

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

  test("pre-end qualifications remain claimable and exhaustion defers the next identity", async () => {
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
    expect(results).toEqual(["credited", "funding_deferred"])

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

  test("canonical 0144 trigger rejects score term mutations", async () => {
    const db = connect(TEST_DB, 1)
    try {
      const message = await postgresErrorMessage(() => db.unsafe(`
        UPDATE reward_campaigns SET min_score_bps = 8000
        WHERE reward_campaign_id = 'rcp_invariants_pg'
      `))
      expect(message).toContain("reward campaign score terms are immutable")
    } finally {
      await db.end()
    }
  })

  test("canonical 0188 trigger rejects permanent pool provider mutations", async () => {
    const db = connect(TEST_DB, 1)
    try {
      const message = await postgresErrorMessage(() => db.unsafe(`
        UPDATE reward_campaigns SET reward_identity_provider = 'zkpassport'
        WHERE reward_campaign_id = 'rcp_invariants_pg'
      `))
      expect(message).toContain("reward campaign identity provider is immutable")
    } finally {
      await db.end()
    }
  })

  test("canonical 0189 backfills legacy default and tier decision amounts", async () => {
    const db = connect(TEST_DB, 1)
    try {
      const rows = await db.unsafe(`
        SELECT result_key, resolved_amount_cents
        FROM reward_nationality_decisions
        WHERE reward_campaign_id = 'rcp_legacy_0189'
        ORDER BY result_key
      `)
      expect(rows).toEqual([
        { result_key: "default", resolved_amount_cents: 25 },
        { result_key: "tier:0", resolved_amount_cents: 75 },
      ])
    } finally {
      await db.end()
    }
  })

  test("canonical 0189 rejects a resolved decision without an amount", async () => {
    const db = connect(TEST_DB, 1)
    try {
      await db.unsafe(`INSERT INTO reward_qualification_events (
        reward_qualification_event_id, user_id, community_id, post_id,
        activity, qualified_at, reward_period_key, source_event_id, status,
        created_at, updated_at
      ) VALUES ('rqe_invalid_0189', 'usr_reward_pg', 'cmt_reward_pg',
        'pst_reward_pg', 'study', $1, '2026-07-10',
        'rqe_invalid_0189', 'pending', $1, $1)`, [NOW])
      const message = await postgresErrorMessage(() => db.unsafe(`
        INSERT INTO reward_nationality_decisions (
          reward_nationality_decision_id, reward_qualification_event_id,
          reward_campaign_id, user_id, result_key, resolved_amount_cents,
          outcome, retryability, campaign_terms_version, evaluator_version,
          evaluated_at, expires_at, created_at
        ) VALUES (
          'rnd_invalid_0189', 'rqe_invalid_0189', 'rcp_reward_pg', 'usr_reward_pg',
          'default', NULL, 'resolved_default', 'resolved', 1, 'test-v1',
          $1, '2027-01-01T00:00:00.000Z', $1
        )
      `, [NOW]))
      expect(message).toContain("reward_nationality_decisions_amount_shape_check")
    } finally {
      await db.end()
    }
  })

  test("canonical 0189 composite FK rejects cross-pool exposure", async () => {
    const db = connect(TEST_DB, 1)
    try {
      await db.unsafe(`INSERT INTO reward_pending_qualifications (
        reward_pending_qualification_id, reward_qualification_event_id,
        reward_campaign_id, user_id, community_id, post_id, reward_period_key,
        reward_kind, qualification_basis, conditional_amount_cents,
        exposure_amount_cents, status, expires_at, created_at, updated_at
      ) VALUES (
        'rpq_cross_pool_0189', 'rqe_cross_pool_0189', 'rcp_reward_pg',
        'usr_reward_pg', 'cmt_reward_pg', 'pst_reward_pg', '2026-07-10',
        'campaign_practice_day', 'study', 40, 40, 'pending_verification',
        '2026-07-17T12:00:00.000Z', $1, $1
      )`, [NOW])
      const message = await postgresErrorMessage(() => db.unsafe(`
        INSERT INTO reward_pending_qualification_funding_exposures (
          reward_pending_qualification_id, reward_campaign_id,
          reward_campaign_funding_effect_id, amount_cents, exposed_at
        ) VALUES (
          'rpq_cross_pool_0189', 'rcp_other_pool_0189',
          'rcf_other_pool_0189', 40, $1
        )
      `, [NOW]))
      expect(message).toContain("reward_pending_qualification_funding_exposures")
    } finally {
      await db.end()
    }
  })

  test("canonical 0189 rejects an open enforcement with a cleared timestamp", async () => {
    const db = connect(TEST_DB, 1)
    try {
      const message = await postgresErrorMessage(() => db.unsafe(`
        INSERT INTO reward_identity_binding_enforcements (
          reward_identity_binding_enforcement_id, user_id, reward_campaign_id,
          status, reason, first_detected_at, last_detected_at, cleared_at,
          expires_at, created_at, updated_at
        ) VALUES (
          'rbe_invalid_0189', 'usr_reward_pg', 'rcp_reward_pg', 'open',
          'identity_binding_mismatch', $1, $1, $1,
          '2027-01-01T00:00:00.000Z', $1, $1
        )
      `, [NOW]))
      expect(message).toContain("reward_binding_enforcement_lifecycle_check")
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
        sql: `INSERT INTO reward_campaign_funding_effects (reward_campaign_funding_effect_id, reward_campaign_id, tx_hash, status, expected_amount_cents, confirmed_block_number, confirmed_block_hash) VALUES ('rcf_invariants_pg', 'rcp_invariants_pg', ?1, 'confirmed', 50, 123, ?2)`,
        args: [`0x${"a".repeat(64)}`, CONFIRMED_BLOCK_HASH],
      })
      await client.execute({
        sql: `UPDATE reward_campaigns SET status = 'paused', funded_cents = 50, reserved_cents = 10 WHERE reward_campaign_id = 'rcp_invariants_pg'`,
        args: [],
      })
      const mismatch = await client.execute({
        sql: `SELECT counters_match, stored_reserved_cents, computed_reserved_cents FROM reward_campaign_accounting_reconciliation WHERE reward_campaign_id = 'rcp_invariants_pg'`,
        args: [],
      })
      expect(mismatch.rows[0]).toMatchObject({ counters_match: false, stored_reserved_cents: 10, computed_reserved_cents: "0" })
      const first = await monitorRewardCampaigns({ env: PG_ENV, client, now: "2026-07-10T12:10:00.000Z", finalityProvider: HEALTHY_FINALITY_PROVIDER })
      expect(first.held).toBe(0)
      expect(first.accounting_mismatches).toBeGreaterThanOrEqual(1)
      expect(first.incidents.map((incident) => incident.campaign_id)).toContain("rcp_invariants_pg")
      const opened = await client.execute({
        sql: `SELECT reward_campaign_incident_id, details_json FROM reward_campaign_incidents WHERE reward_campaign_id = 'rcp_invariants_pg' AND incident_kind = 'accounting_mismatch' AND resolved_at IS NULL`,
        args: [],
      })
      expect(JSON.parse(String(opened.rows[0]?.details_json))).toMatchObject({ stored_reserved_cents: 10 })
      const openedIncidentId = String(opened.rows[0]?.reward_campaign_incident_id)
      await markRewardCampaignIncidentAlerted({ client, incidentId: openedIncidentId, alertedAt: "2026-07-10T12:10:05.000Z" })
      await markRewardCampaignIncidentAlerted({ client, incidentId: openedIncidentId, alertedAt: "2026-07-10T12:10:30.000Z" })
      await client.execute({
        sql: `UPDATE reward_campaigns SET reserved_cents = 20 WHERE reward_campaign_id = 'rcp_invariants_pg'`,
        args: [],
      })
      const overlapping = await monitorRewardCampaigns({ env: PG_ENV, client, now: "2026-07-10T12:10:20.000Z", finalityProvider: HEALTHY_FINALITY_PROVIDER })
      expect(overlapping.held).toBe(0)
      const lastSeen = await client.execute({
        sql: `SELECT last_seen_at, occurrence_count FROM reward_campaign_incidents WHERE reward_campaign_incident_id = ?1`,
        args: [openedIncidentId],
      })
      expect(new Date(String(lastSeen.rows[0]?.last_seen_at)).toISOString()).toBe("2026-07-10T12:10:20.000Z")
      expect(Number(lastSeen.rows[0]?.occurrence_count)).toBe(1)
      let campaign = await client.execute({ sql: `SELECT status FROM reward_campaigns WHERE reward_campaign_id = 'rcp_invariants_pg'`, args: [] })
      expect(campaign.rows[0]?.status).toBe("paused")
      const second = await monitorRewardCampaigns({ env: PG_ENV, client, now: "2026-07-10T12:11:00.000Z", finalityProvider: HEALTHY_FINALITY_PROVIDER })
      expect(second.held).toBeGreaterThanOrEqual(1)
      const observed = await client.execute({
        sql: `SELECT details_json, alerted_at, occurrence_count FROM reward_campaign_incidents WHERE reward_campaign_id = 'rcp_invariants_pg' AND incident_kind = 'accounting_mismatch' AND resolved_at IS NULL`,
        args: [],
      })
      expect(JSON.parse(String(observed.rows[0]?.details_json))).toMatchObject({ stored_reserved_cents: 10 })
      expect(new Date(String(observed.rows[0]?.alerted_at)).toISOString()).toBe("2026-07-10T12:10:05.000Z")
      expect(Number(observed.rows[0]?.occurrence_count)).toBe(2)
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
        sql: `UPDATE reward_campaigns SET funded_cents = 50, reserved_cents = 0 WHERE reward_campaign_id = 'rcp_invariants_pg'`,
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
        finalityProvider: HEALTHY_FINALITY_PROVIDER,
      })).rejects.toThrow("incident changed")
      await recoverRewardCampaignIncident({
        env: PG_ENV, client, campaignId: "rcp_invariants_pg",
        incidentId: String(incident.reward_campaign_incident_id),
        incidentVersion: Number(incident.incident_version), operatorActorId: "operator-test",
        resolutionNote: "Authoritative counters restored", now: "2026-07-10T12:12:00.000Z",
        finalityProvider: HEALTHY_FINALITY_PROVIDER,
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
      await db.unsafe(`
        INSERT INTO reward_campaign_funding_effects (
          reward_campaign_funding_effect_id, reward_campaign_id, tx_hash, status,
          expected_amount_cents, confirmed_block_number, confirmed_block_hash
        ) VALUES ('rcf_recovery_race_pg', 'rcp_recovery_race_pg', $1, 'confirmed', 0, 123, $2)
      `, [`0x${"b".repeat(64)}`, CONFIRMED_BLOCK_HASH])
      await db.unsafe("BEGIN")
      await db.unsafe(`SELECT reward_campaign_id FROM reward_campaigns WHERE reward_campaign_id = 'rcp_recovery_race_pg' FOR UPDATE`)
      await db.unsafe(`UPDATE reward_campaigns SET funded_cents = 10 WHERE reward_campaign_id = 'rcp_recovery_race_pg'`)

      const recovery = withProductionPostgresClient((client) => recoverRewardCampaignIncident({
        env: PG_ENV, client, campaignId: "rcp_recovery_race_pg",
        incidentId: "rci_recovery_race_pg", incidentVersion: 1,
        operatorActorId: "operator-test", resolutionNote: "Attempt while writer commits",
        now: "2026-07-10T12:30:00.000Z",
        finalityProvider: HEALTHY_FINALITY_PROVIDER,
      }))
      await sleep(50)
      await db.unsafe("COMMIT")
      await expect(recovery).rejects.toThrow("accounting is not healthy")
      const rows = await db.unsafe(`SELECT status FROM reward_campaigns WHERE reward_campaign_id = 'rcp_recovery_race_pg'`) as Array<{ status: string }>
      expect(rows[0]?.status).toBe("operational_hold")
    } finally {
      await db.unsafe("ROLLBACK").catch(() => {})
      await db.end()
    }
  })

  test("recovery verifies accounting and funding, resolves every open incident, and restores once", async () => {
    await withProductionPostgresClient(async (client) => {
      await client.execute({
        sql: `UPDATE reward_campaigns SET status = 'operational_hold', status_before_operational_hold = 'paused', operational_hold_reason = 'multiple incidents', operational_held_at = ?2, operational_held_by = 'scheduled_monitor', reserved_cents = 10 WHERE reward_campaign_id = ?1`,
        args: ["rcp_invariants_pg", "2026-07-10T12:40:00.000Z"],
      })
      await client.execute({
        sql: `INSERT INTO reward_campaign_incidents (reward_campaign_incident_id, reward_campaign_id, incident_kind, reason, details_json, opened_at, last_seen_at, alert_owner, alert_destination, alerted_at) VALUES ('rci_multi_accounting_pg', 'rcp_invariants_pg', 'accounting_mismatch', 'campaign_accounting_counters_mismatch', '{}', ?1, ?1, 'reward-operator', 'ops@example.test', ?1), ('rci_multi_finality_pg', 'rcp_invariants_pg', 'funding_finality_failure', 'confirmed_funding_receipt_not_canonical', '{}', ?1, ?1, 'reward-operator', 'ops@example.test', ?1)`,
        args: ["2026-07-10T12:40:00.000Z"],
      })
      await client.execute({
        sql: `UPDATE reward_campaign_incidents SET alerted_at = NULL WHERE reward_campaign_incident_id = 'rci_multi_finality_pg'`,
        args: [],
      })

      await expect(recoverRewardCampaignIncident({
        env: PG_ENV, client, campaignId: "rcp_invariants_pg",
        incidentId: "rci_multi_finality_pg", incidentVersion: 1,
        operatorActorId: "operator-test", resolutionNote: "Both dimensions verified",
        now: "2026-07-10T12:41:00.000Z", finalityProvider: HEALTHY_FINALITY_PROVIDER,
      })).rejects.toThrow("accounting is not healthy")

      await client.execute({
        sql: `UPDATE reward_campaigns SET reserved_cents = 0 WHERE reward_campaign_id = 'rcp_invariants_pg'`,
        args: [],
      })
      await expect(recoverRewardCampaignIncident({
        env: PG_ENV, client, campaignId: "rcp_invariants_pg",
        incidentId: "rci_multi_finality_pg", incidentVersion: 1,
        operatorActorId: "operator-test", resolutionNote: "Both dimensions verified",
        now: "2026-07-10T12:42:00.000Z", finalityProvider: REORGED_FINALITY_PROVIDER,
      })).rejects.toThrow("funding finality is not healthy")

      await expect(recoverRewardCampaignIncident({
        env: PG_ENV, client, campaignId: "rcp_invariants_pg",
        incidentId: "rci_multi_finality_pg", incidentVersion: 1,
        operatorActorId: "operator-test", resolutionNote: "Both dimensions verified",
        now: "2026-07-10T12:42:30.000Z", finalityProvider: HEALTHY_FINALITY_PROVIDER,
      })).rejects.toThrow("incidents have not been delivered")
      await markRewardCampaignIncidentAlerted({
        client, incidentId: "rci_multi_finality_pg", alertedAt: "2026-07-10T12:42:40.000Z",
      })

      const recovered = await recoverRewardCampaignIncident({
        env: PG_ENV, client, campaignId: "rcp_invariants_pg",
        incidentId: "rci_multi_finality_pg", incidentVersion: 1,
        operatorActorId: "operator-test", resolutionNote: "Both dimensions verified",
        now: "2026-07-10T12:43:00.000Z", finalityProvider: HEALTHY_FINALITY_PROVIDER,
      })
      expect(recovered).toEqual({ campaign_id: "rcp_invariants_pg", status: "paused" })
      const incidents = await client.execute({
        sql: `SELECT reward_campaign_incident_id, resolved_by, resolution_note, incident_version FROM reward_campaign_incidents WHERE reward_campaign_incident_id IN ('rci_multi_accounting_pg', 'rci_multi_finality_pg') ORDER BY reward_campaign_incident_id`,
        args: [],
      })
      expect(incidents.rows).toEqual([
        { reward_campaign_incident_id: "rci_multi_accounting_pg", resolved_by: "operator-test", resolution_note: "Both dimensions verified", incident_version: 2 },
        { reward_campaign_incident_id: "rci_multi_finality_pg", resolved_by: "operator-test", resolution_note: "Both dimensions verified", incident_version: 2 },
      ])
    })
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
      await monitorRewardCampaigns({ env: PG_ENV, client, now: "2026-07-10T13:00:00.000Z", finalityProvider: HEALTHY_FINALITY_PROVIDER })
      await monitorRewardCampaigns({ env: PG_ENV, client, now: "2026-07-10T13:01:00.000Z", finalityProvider: HEALTHY_FINALITY_PROVIDER })
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

  test("wholly blind and partial finality scans advance liveness without inventing completeness", async () => {
    await withProductionPostgresClient(async (client) => {
      await client.execute({
        sql: `INSERT INTO reward_campaign_monitor_state (monitor_name, first_attempted_scan_at, last_attempted_scan_at, last_successful_scan_at, updated_at) VALUES ('reward_campaign_integrity', ?1, ?1, ?1, ?1) ON CONFLICT (monitor_name) DO UPDATE SET first_attempted_scan_at = excluded.first_attempted_scan_at, last_attempted_scan_at = excluded.last_attempted_scan_at, last_successful_scan_at = excluded.last_successful_scan_at, updated_at = excluded.updated_at`,
        args: ["2026-07-10T13:10:00.000Z"],
      })
      const blind = await monitorRewardCampaigns({
        env: PG_ENV, client, now: "2026-07-10T13:20:00.000Z", limit: 500,
        finalityProvider: TRANSIENT_FINALITY_PROVIDER,
      })
      expect(blind.transient_finality_checks).toBeGreaterThan(0)
      expect(blind.finality_checks_attempted).toBe(blind.transient_finality_checks)
      expect(blind.wholly_blind).toBe(true)
      expect(blind.partial_finality_degraded).toBe(false)
      expect(blind.scan_successful).toBe(false)
      let heartbeat = await client.execute({
        sql: `SELECT last_attempted_scan_at, last_successful_scan_at FROM reward_campaign_monitor_state WHERE monitor_name = 'reward_campaign_integrity'`,
        args: [],
      })
      expect(new Date(String(heartbeat.rows[0]?.last_attempted_scan_at)).toISOString()).toBe("2026-07-10T13:20:00.000Z")
      expect(new Date(String(heartbeat.rows[0]?.last_successful_scan_at)).toISOString()).toBe("2026-07-10T13:10:00.000Z")

      const partial = await monitorRewardCampaigns({
        env: PG_ENV, client, now: "2026-07-10T13:21:00.000Z", limit: 500,
        finalityProvider: PARTIAL_FINALITY_PROVIDER,
      })
      expect(partial.finality_checks_attempted).toBeGreaterThan(partial.transient_finality_checks)
      expect(partial.transient_finality_checks).toBeGreaterThan(0)
      expect(partial.wholly_blind).toBe(false)
      expect(partial.partial_finality_degraded).toBe(true)
      expect(partial.scan_successful).toBe(false)
      heartbeat = await client.execute({
        sql: `SELECT last_attempted_scan_at, last_successful_scan_at FROM reward_campaign_monitor_state WHERE monitor_name = 'reward_campaign_integrity'`,
        args: [],
      })
      expect(new Date(String(heartbeat.rows[0]?.last_attempted_scan_at)).toISOString()).toBe("2026-07-10T13:21:00.000Z")
      expect(new Date(String(heartbeat.rows[0]?.last_successful_scan_at)).toISOString()).toBe("2026-07-10T13:10:00.000Z")
    })
  })

  test("liveness and coverage staleness are independent and cold-start blindness stays nullable", async () => {
    await withProductionPostgresClient(async (client) => {
      await client.execute({
        sql: `UPDATE reward_campaign_monitor_state SET first_attempted_scan_at = ?1, last_attempted_scan_at = ?1, last_successful_scan_at = ?1, updated_at = ?1 WHERE monitor_name = 'reward_campaign_integrity'`,
        args: ["2026-07-10T12:50:00.000Z"],
      })
      const resumed = await monitorRewardCampaigns({
        env: PG_ENV, client, now: "2026-07-10T13:20:01.000Z", limit: 500,
        finalityProvider: HEALTHY_FINALITY_PROVIDER,
      })
      expect(resumed.liveness_stale).toBe(true)
      expect(resumed.coverage_stale).toBe(false)
      expect(resumed.scan_successful).toBe(true)

      await client.execute({
        sql: `UPDATE reward_campaign_monitor_state SET first_attempted_scan_at = ?1, last_attempted_scan_at = ?2, last_successful_scan_at = NULL, updated_at = ?2 WHERE monitor_name = 'reward_campaign_integrity'`,
        args: ["2026-07-10T12:50:00.000Z", "2026-07-10T13:19:00.000Z"],
      })
      const neverComplete = await monitorRewardCampaigns({
        env: PG_ENV, client, now: "2026-07-10T13:20:02.000Z", limit: 500,
        finalityProvider: TRANSIENT_FINALITY_PROVIDER,
      })
      expect(neverComplete.liveness_stale).toBe(false)
      expect(neverComplete.coverage_stale).toBe(true)
      expect(neverComplete.scan_successful).toBe(false)

      await client.execute({
        sql: `DELETE FROM reward_campaign_monitor_state WHERE monitor_name = 'reward_campaign_integrity'`,
        args: [],
      })
      const coldBlind = await monitorRewardCampaigns({
        env: PG_ENV, client, now: "2026-07-10T13:20:03.000Z", limit: 500,
        finalityProvider: TRANSIENT_FINALITY_PROVIDER,
      })
      expect(coldBlind.wholly_blind).toBe(true)
      expect(coldBlind.coverage_stale).toBe(false)
      const state = await client.execute({
        sql: `SELECT first_attempted_scan_at, last_attempted_scan_at, last_successful_scan_at FROM reward_campaign_monitor_state WHERE monitor_name = 'reward_campaign_integrity'`,
        args: [],
      })
      expect(new Date(String(state.rows[0]?.first_attempted_scan_at)).toISOString()).toBe("2026-07-10T13:20:03.000Z")
      expect(new Date(String(state.rows[0]?.last_attempted_scan_at)).toISOString()).toBe("2026-07-10T13:20:03.000Z")
      expect(state.rows[0]?.last_successful_scan_at).toBeNull()
    })
  })

  test("coordinator mirror accepts a nullable pre-signing transaction reference", async () => {
    await withProductionPostgresClient(async (client) => {
      await client.execute({
        sql: `
          INSERT INTO reward_payout_effects (
            reward_payout_effect_id, user_id, amount_cents, recipient_address,
            idempotency_key, status, submitted_at, created_at, updated_at
          ) VALUES (?1, ?2, 100, ?3, ?4, 'submitted', ?5, ?5, ?5)
        `,
        args: [
          "rpe_null_mirror_pg",
          "usr_reward_pg",
          "0xCc4049cEd4ff4C3CA25F7e32eDb8c69dEA4bB12f",
          "reward-null-mirror-pg",
          NOW,
        ],
      })
      const updated = await client.execute({
        sql: REWARD_PAYOUT_COORDINATOR_MIRROR_SQL,
        args: [
          "reward-null-mirror-pg",
          '["reward_payout","reward-null-mirror-pg"]',
          "reserving",
          null,
          null,
          NOW,
          "usr_reward_pg",
        ],
      })
      expect(updated.rows[0]?.coordinator_state).toBe("reserving")
      expect(updated.rows[0]?.settlement_ref).toBeNull()
      // The production Postgres decoder omits some nullable integer keys rather
      // than materialising them as `null`; either representation is still null.
      expect(updated.rows[0]?.broadcast_nonce ?? null).toBeNull()
    })
  })

  test("a definitive finality loss is complete coverage and holds on repeated observation", async () => {
    await withProductionPostgresClient(async (client) => {
      const first = await monitorRewardCampaigns({
        env: PG_ENV, client, now: "2026-07-10T13:21:00.000Z", limit: 500,
        finalityProvider: REORGED_FINALITY_PROVIDER,
      })
      expect(first.finality_failures).toBeGreaterThan(0)
      expect(first.scan_successful).toBe(true)
      await monitorRewardCampaigns({
        env: PG_ENV, client, now: "2026-07-10T13:22:00.000Z", limit: 500,
        finalityProvider: REORGED_FINALITY_PROVIDER,
      })
      const campaign = await client.execute({
        sql: `SELECT status FROM reward_campaigns WHERE reward_campaign_id = 'rcp_invariants_pg'`,
        args: [],
      })
      expect(campaign.rows[0]?.status).toBe("operational_hold")
      const heartbeat = await client.execute({
        sql: `SELECT last_successful_scan_at FROM reward_campaign_monitor_state WHERE monitor_name = 'reward_campaign_integrity'`,
        args: [],
      })
      expect(new Date(String(heartbeat.rows[0]?.last_successful_scan_at)).toISOString()).toBe("2026-07-10T13:22:00.000Z")
    })
  })

  test("rotates bounded monitor pages so candidates after the first page are observed", async () => {
    const db = connect(TEST_DB, 1)
    try {
      await db.unsafe(`
        INSERT INTO reward_campaigns (
          reward_campaign_id, rewarder_user_id, creation_idempotency_key, community_id,
          post_id, song_artifact_bundle_id, song_owner_user_id, status, eligible_activity,
          daily_reward_cents, reward_period_cap_cents, budget_cents, funded_cents,
          reserved_cents, credited_cents, paid_cents, refunded_cents, terms_version,
          terms_hash, starts_at, ends_at, updated_at
        )
        SELECT
          'rcp_page_' || LPAD(series::text, 3, '0'), 'usr_reward_pg',
          'page-' || series::text, 'cmt_page_pg', 'pst_page_' || series::text,
          'sab_page_' || series::text, 'usr_reward_pg', 'active', 'study',
          1, 1, 1, 1, 0, 0, 0, 0, 1, 'terms-page-' || series::text,
          '2026-07-01T00:00:00.000Z', '2026-07-31T00:00:00.000Z', $1
        FROM generate_series(1, 101) AS series
      `, [NOW])
      await db.unsafe(`
        INSERT INTO reward_campaign_funding_effects (
          reward_campaign_funding_effect_id, reward_campaign_id, tx_hash, status,
          expected_amount_cents, confirmed_block_number, confirmed_block_hash
        )
        SELECT 'rcf_page_' || LPAD(series::text, 3, '0'),
          'rcp_page_' || LPAD(series::text, 3, '0'), '0x' || LPAD(series::text, 64, '0'),
          'confirmed', 1, NULL, NULL
        FROM generate_series(1, 101) AS series
      `)
    } finally {
      await db.end()
    }
    await withProductionPostgresClient(async (client) => {
      await monitorRewardCampaigns({ env: PG_ENV, client, now: "2026-07-10T13:30:00.000Z", limit: 100, finalityProvider: HEALTHY_FINALITY_PROVIDER })
      await monitorRewardCampaigns({ env: PG_ENV, client, now: "2026-07-10T13:31:00.000Z", limit: 100, finalityProvider: HEALTHY_FINALITY_PROVIDER })
      const incidents = await client.execute({
        sql: `SELECT COUNT(*) AS count FROM reward_campaign_incidents WHERE reward_campaign_id LIKE 'rcp_page_%' AND incident_kind = 'funding_provenance_missing'`,
        args: [],
      })
      expect(Number(incidents.rows[0]?.count)).toBe(101)
    })
  })
})
