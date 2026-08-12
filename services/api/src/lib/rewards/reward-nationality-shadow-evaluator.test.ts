import { afterEach, describe, expect, test } from "bun:test"
import type { Env } from "../../env"
import type { Client } from "../sql-client"
import { createControlPlaneTestClient } from "../../../tests/helpers"
import { deriveRewardIdentityId } from "../verification/unique-human-eligibility"
import {
  evaluateRewardNationalityBindingShadow,
  REWARD_NATIONALITY_EVALUATOR_VERSION,
  resolveRewardNationalityBinding,
  resolveRewardNationalityBindingShadow,
} from "./reward-nationality-shadow-evaluator"
import { enforceRewardNationalityDecisionRetention } from "./reward-nationality-retention"

const NOW = "2026-08-02T10:00:00.000Z"
const SELF_ENV = {
  REWARDS_IDENTITY_PROVIDER: "very",
  REWARDS_NATIONALITY_SHADOW_WRITES_ENABLED: "true",
  REWARDS_NATIONALITY_SHADOW_IDENTITY_PROVIDER: "self",
} as Env
const VERY_ENV = {
  REWARDS_IDENTITY_PROVIDER: "self",
  REWARDS_NATIONALITY_SHADOW_WRITES_ENABLED: "true",
  REWARDS_NATIONALITY_SHADOW_IDENTITY_PROVIDER: "very",
} as Env
const PAUSED_ENV = { REWARDS_IDENTITY_PROVIDER: "self" } as Env
let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  await cleanup?.()
  cleanup = null
})

async function setup(): Promise<Client> {
  const result = await createControlPlaneTestClient({ includeAllMigrations: true })
  cleanup = result.cleanup
  await result.client.execute({
    sql: `
      INSERT INTO users (
        user_id, verification_state, capability_provider,
        verification_capabilities_json, verified_at, created_at, updated_at
      ) VALUES ('usr_shadow', 'verified', 'zkpass', ?1, ?2, ?2, ?2)
    `,
    // This deliberately hostile account projection must never influence the
    // document-scoped decision below.
    args: [JSON.stringify({
      unique_human: { state: "verified", provider: "self", mechanism: "zk-nullifier" },
      nationality: { state: "verified", provider: "zkpassport", value: "VNM" },
    }), NOW],
  })
  await result.client.execute({
    sql: `
      INSERT INTO communities (
        community_id, creator_user_id, display_name, membership_mode, status,
        provisioning_state, transfer_state, created_at, updated_at
      ) VALUES ('cmt_shadow', 'usr_shadow', 'Shadow rewards', 'open', 'active',
        'active', 'none', ?1, ?1)
    `,
    args: [NOW],
  })
  await result.client.execute({
    sql: `
      INSERT INTO reward_campaigns (
        reward_campaign_id, rewarder_user_id, creation_idempotency_key,
        community_id, post_id, song_artifact_bundle_id, song_owner_user_id,
        status, eligible_activity, daily_reward_cents, default_amount_cents,
        max_claim_cents, payout_tiers_json, reward_period_cap_cents,
        budget_cents, funded_cents, reserved_cents, credited_cents, paid_cents,
        refunded_cents, terms_version, terms_hash, starts_at, ends_at, updated_at
      ) VALUES (
        'rcp_shadow', 'usr_shadow', 'create-shadow', 'cmt_shadow', 'pst_shadow',
        'sab_shadow', 'usr_shadow', 'active', 'either', 100, 100, 500, ?1,
        500, 1000, 1000, 17, 23, 0, 11, 1, 'terms-shadow',
        '2026-08-01T00:00:00.000Z', '2026-08-31T23:59:59.999Z', ?2
      )
    `,
    args: [JSON.stringify([{ nationalities: ["CAN"], amount_cents: 500 }]), NOW],
  })
  return result.client
}

async function seedQualification(client: Client, id: string): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO reward_qualification_events (
        reward_qualification_event_id, community_id, shard_sequence, user_id,
        post_id, song_artifact_bundle_id, activity, qualified_at,
        reward_period_key, qualification_policy_version, evidence_summary_json
      ) VALUES (?1, 'cmt_shadow', ?2, 'usr_shadow', 'pst_shadow', 'sab_shadow',
        'study', ?3, '2026-08-02', 'study_session_first_pass_v2', '{}')
    `,
    args: [id, Number(id.replace(/\D/gu, "")) || 1, NOW],
  })
}

async function seedNullifier(client: Client, input: {
  id: string
  hash: string
  status?: "active" | "revoked"
  nationality?: string
  secondNationality?: string
  provider?: "self" | "zkpassport"
}): Promise<void> {
  const provider = input.provider ?? "self"
  await client.execute({
    sql: `
      INSERT INTO identity_nullifiers (
        identity_nullifier_id, user_id, provider, mechanism, nullifier_hash,
        status, first_seen_at, created_at, updated_at
      ) VALUES (?1, 'usr_shadow', ?2, 'zk-nullifier', ?3, ?4, ?5, ?5, ?5)
    `,
    args: [input.id, provider, input.hash, input.status ?? "active", NOW],
  })
  if (input.nationality || input.secondNationality) {
    await client.execute({
      sql: `
        INSERT INTO verification_sessions (
          verification_session_id, user_id, provider, session_kind,
          requested_capabilities_json, status, started_at, completed_at,
          created_at, updated_at
        ) VALUES (?1, 'usr_shadow', ?2, 'identity', '["nationality"]',
          'verified', ?3, ?3, ?3, ?3)
      `,
      args: [`vss_${input.id}`, provider, NOW],
    })
  }
  for (const [index, nationality] of [input.nationality, input.secondNationality].entries()) {
    if (!nationality) continue
    await client.execute({
      sql: `
        INSERT INTO user_attestations (
          user_attestation_id, user_id, source_verification_session_id, provider,
          attestation_type, capability_key, status, value_json, verified_at,
          revoked_at, created_at, updated_at, source_identity_nullifier_id
        ) VALUES (?1, 'usr_shadow', ?2, ?3, 'nationality', 'nationality',
          'accepted', ?4, ?5, NULL, ?5, ?5, ?6)
      `,
      args: [`att_${input.id}_${index}`, `vss_${input.id}`, provider,
        JSON.stringify({ nationality }), NOW, input.id],
    })
  }
}

async function bind(client: Client, identityNullifierId: string): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO reward_identity_bindings (
        reward_identity_binding_id, user_id, identity_nullifier_id, status,
        selected_at, created_at, updated_at
      ) VALUES (?1, 'usr_shadow', ?2, 'active', ?3, ?3, ?3)
    `,
    args: [`rib_${identityNullifierId}`, identityNullifierId, NOW],
  })
}

async function evaluate(client: Client, eventId: string, env = SELF_ENV) {
  await seedQualification(client, eventId)
  return evaluateRewardNationalityBindingShadow({
    env,
    client,
    rewardQualificationEventId: eventId,
    rewardCampaignId: "rcp_shadow",
    userId: "usr_shadow",
    now: NOW,
  })
}

describe("reward nationality shadow evaluation", () => {
  test("does not resolve or persist nationality evidence unless collection is explicitly enabled", async () => {
    const client = await setup()
    await seedNullifier(client, { id: "nul_paused", hash: "hash_paused", nationality: "CAN" })
    await bind(client, "nul_paused")

    expect(await evaluate(client, "rqe_shadow_paused", PAUSED_ENV)).toMatchObject({
      capability: "paused",
      persisted: false,
      persistence: "not_applicable",
      evaluatorVersion: null,
      outcome: null,
    })
    expect((await client.execute("SELECT COUNT(*) AS count FROM reward_nationality_decisions")).rows[0]?.count).toBe(0)
  })

  test("resolves nationality and reward identity from the selected nullifier, never the account slot or oldest document", async () => {
    const client = await setup()
    await seedNullifier(client, { id: "nul_oldest", hash: "hash_oldest", nationality: "USA" })
    await seedNullifier(client, { id: "nul_selected", hash: "hash_selected", nationality: "CAN" })
    await bind(client, "nul_selected")

    expect(await resolveRewardNationalityBindingShadow({
      env: SELF_ENV,
      client,
      userId: "usr_shadow",
    })).toMatchObject({
      persisted: false,
      persistence: "not_attempted",
      evaluatorVersion: REWARD_NATIONALITY_EVALUATOR_VERSION,
      outcome: "resolved",
    })

    const before = await client.execute({
      sql: `SELECT funded_cents, reserved_cents, credited_cents, refunded_cents
        FROM reward_campaigns WHERE reward_campaign_id = 'rcp_shadow'`,
    })
    const decision = await evaluate(client, "rqe_shadow_1")

    expect(decision).toMatchObject({
      capability: "binding_preview",
      persisted: true,
      persistence: "written",
      evaluatorVersion: REWARD_NATIONALITY_EVALUATOR_VERSION,
      outcome: "resolved",
      retryability: "resolved",
      rewardIdentityBindingId: "rib_nul_selected",
      identityNullifierId: "nul_selected",
      userAttestationId: "att_nul_selected_0",
      nationality: "CAN",
      rewardIdentityId: await deriveRewardIdentityId("self", "zk-nullifier", "hash_selected"),
      evidenceVerificationSessionId: "vss_nul_selected",
    })
    expect((await client.execute({
      sql: `SELECT funded_cents, reserved_cents, credited_cents, refunded_cents
        FROM reward_campaigns WHERE reward_campaign_id = 'rcp_shadow'`,
    })).rows).toEqual(before.rows)
    expect((await client.execute("SELECT COUNT(*) AS count FROM reward_campaign_reservations")).rows[0]?.count).toBe(0)
    expect((await client.execute("SELECT COUNT(*) AS count FROM reward_events")).rows[0]?.count).toBe(0)
    expect((await client.execute("SELECT COUNT(*) AS count FROM reward_song_period_claims")).rows[0]?.count).toBe(0)
    expect((await client.execute("SELECT COUNT(*) AS count FROM reward_pending_qualifications")).rows[0]?.count).toBe(0)
    expect((await client.execute(`
      SELECT result_key, outcome, retryability, campaign_terms_version,
        evaluator_version, evaluated_at, expires_at
      FROM reward_nationality_decisions
      WHERE reward_qualification_event_id = 'rqe_shadow_1'
    `)).rows).toEqual([{
      result_key: "tier:0",
      outcome: "resolved_tier",
      retryability: "resolved",
      campaign_terms_version: 1,
      evaluator_version: REWARD_NATIONALITY_EVALUATOR_VERSION,
      evaluated_at: NOW,
      expires_at: "2027-02-27T23:59:59.999Z",
    }])
  })

  test("resolves ZKPassport nationality from its provider-local nullifier without a Self document binding", async () => {
    const client = await setup()
    await seedNullifier(client, {
      id: "nul_zkpassport",
      hash: "hash_zkpassport",
      nationality: "VNM",
      provider: "zkpassport",
    })

    expect(await resolveRewardNationalityBinding({
      client,
      userId: "usr_shadow",
      requiredProvider: "zkpassport",
    })).toMatchObject({
      outcome: "resolved",
      retryability: "resolved",
      identityNullifierId: "nul_zkpassport",
      nationality: "VNM",
      rewardIdentityId: await deriveRewardIdentityId(
        "zkpassport", "zk-nullifier", "hash_zkpassport",
      ),
      rewardIdentityBindingId: null,
    })
  })

  test("records retryable document-not-selected and missing-evidence reasons distinctly", async () => {
    const client = await setup()
    expect(await evaluate(client, "rqe_shadow_2")).toMatchObject({
      outcome: "identity_document_not_selected",
      retryability: "retryable",
    })

    await seedNullifier(client, { id: "nul_missing", hash: "hash_missing" })
    await bind(client, "nul_missing")
    expect(await evaluateRewardNationalityBindingShadow({
      env: SELF_ENV,
      client,
      rewardQualificationEventId: "rqe_shadow_2",
      rewardCampaignId: "rcp_shadow",
      userId: "usr_shadow",
      now: "2026-08-02T11:00:00.000Z",
    })).toMatchObject({
      persisted: true,
      persistence: "written",
      evaluatorVersion: REWARD_NATIONALITY_EVALUATOR_VERSION,
      outcome: "nationality_evidence_missing",
      retryability: "retryable",
    })
    expect(await evaluate(client, "rqe_shadow_3")).toMatchObject({
      outcome: "nationality_evidence_missing",
      retryability: "retryable",
    })
  })

  test("records revoked bindings and conflicting evidence as terminal reasons", async () => {
    const client = await setup()
    await seedNullifier(client, { id: "nul_revoked", hash: "hash_revoked", status: "revoked", nationality: "USA" })
    await bind(client, "nul_revoked")
    expect(await evaluate(client, "rqe_shadow_4")).toMatchObject({
      outcome: "identity_binding_mismatch",
      retryability: "terminal",
    })

    await client.execute("UPDATE reward_identity_bindings SET status = 'superseded', superseded_at = '2026-08-02T11:00:00.000Z' WHERE reward_identity_binding_id = 'rib_nul_revoked'")
    await seedNullifier(client, { id: "nul_conflict", hash: "hash_conflict", nationality: "USA", secondNationality: "CAN" })
    await bind(client, "nul_conflict")
    expect(await evaluate(client, "rqe_shadow_5")).toMatchObject({
      outcome: "identity_evidence_conflict",
      retryability: "terminal",
    })
  })

  test("does not create a permanently pending per-claim row for an unsupported shadow provider", async () => {
    const client = await setup()
    const decision = await evaluate(client, "rqe_shadow_6", VERY_ENV)
    expect(decision).toMatchObject({
      capability: "unavailable",
      persisted: false,
      persistence: "not_applicable",
      evaluatorVersion: null,
      outcome: null,
    })
    expect((await client.execute("SELECT COUNT(*) AS count FROM reward_nationality_decisions")).rows[0]?.count).toBe(0)
  })

  test("distinguishes a missing qualification from an immutable existing snapshot", async () => {
    const client = await setup()
    const decision = await evaluateRewardNationalityBindingShadow({
      env: SELF_ENV,
      client,
      rewardQualificationEventId: "rqe_not_ingested",
      rewardCampaignId: "rcp_shadow",
      userId: "usr_shadow",
      now: NOW,
    })
    expect(decision).toMatchObject({
      persisted: false,
      persistence: "not_recorded",
      evaluatorVersion: REWARD_NATIONALITY_EVALUATOR_VERSION,
      outcome: "identity_document_not_selected",
    })
  })

  test("keeps the first shadow snapshot immutable across retries", async () => {
    const client = await setup()
    await seedNullifier(client, { id: "nul_retry", hash: "hash_retry", nationality: "USA" })
    await bind(client, "nul_retry")
    const first = await evaluate(client, "rqe_shadow_7")
    const retry = await evaluateRewardNationalityBindingShadow({
      env: SELF_ENV,
      client,
      rewardQualificationEventId: "rqe_shadow_7",
      rewardCampaignId: "rcp_shadow",
      userId: "usr_shadow",
      now: "2026-08-02T12:00:00.000Z",
    })
    expect(first.persisted).toBe(true)
    expect(first.persistence).toBe("written")
    expect(retry.persisted).toBe(true)
    expect(retry.persistence).toBe("already_recorded")
    const rows = await client.execute("SELECT evaluator_version, evaluated_at, COUNT(*) OVER () AS count FROM reward_nationality_decisions")
    expect(rows.rows).toEqual([{
      evaluator_version: REWARD_NATIONALITY_EVALUATOR_VERSION,
      evaluated_at: NOW,
      count: 1,
    }])
  })

  test("deletes expired minimal decisions and verifies that no overdue rows remain", async () => {
    const client = await setup()
    await seedNullifier(client, { id: "nul_retention", hash: "hash_retention", nationality: "CAN" })
    await bind(client, "nul_retention")
    await evaluate(client, "rqe_shadow_8")

    expect(await enforceRewardNationalityDecisionRetention({
      client,
      now: "2027-02-28T00:00:00.000Z",
    })).toEqual({
      owner: "rewards-operations",
      deleted: 1,
      overdue: 0,
      checkedAt: "2027-02-28T00:00:00.000Z",
    })
    expect((await client.execute("SELECT COUNT(*) AS count FROM reward_nationality_decisions")).rows[0]?.count).toBe(0)
  })
})
