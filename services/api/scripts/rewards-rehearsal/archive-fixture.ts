import { requiredNumber, requiredString, rowValue } from "../../src/lib/sql-row"
import type { Client, QueryResultRow, Transaction } from "../../src/lib/sql-client"
import { withTransaction } from "../../src/lib/transactions"
import {
  REHEARSAL_FIXTURE_ARCHIVE_REASON,
  REHEARSAL_FIXTURE_KIND,
  rehearsalFixtureFundingEffectId,
} from "./fixture-audit"

const CAMPAIGN_ID_RE = /^rcp_[0-9a-f]{32}$/u
const ARCHIVE_ACTOR = "staging_reward_fixture_archive"

export type RehearsalFixtureArchiveResult = {
  campaign_id: string
  outcome: "eligible" | "archived" | "already_archived"
  archive_reason: typeof REHEARSAL_FIXTURE_ARCHIVE_REASON
  evidence: Record<string, unknown>
}

function integer(row: QueryResultRow | undefined, field: string): number {
  const value = requiredNumber(row, field)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`fixture_archive_invalid_${field}`)
  }
  return value
}

async function first(tx: Transaction, sql: string, args: unknown[]): Promise<QueryResultRow | undefined> {
  return (await tx.execute({ sql, args })).rows[0]
}

function requireFixtureShape(input: {
  campaignId: string
  campaign: QueryResultRow
  realFundingEffects: number
  reservations: QueryResultRow
  payouts: QueryResultRow
  activePoolRows: number
  otherOpenIncidents: number
}): Record<string, unknown> {
  const fundedCents = integer(input.campaign, "funded_cents")
  const creditedCents = integer(input.campaign, "credited_cents")
  const paidCents = integer(input.campaign, "paid_cents")
  const reservedCents = integer(input.campaign, "reserved_cents")
  const refundedCents = integer(input.campaign, "refunded_cents")
  const reservationCount = integer(input.reservations, "reservation_count")
  const reservationCreditedCents = integer(input.reservations, "credited_cents")
  const invalidReservations = integer(input.reservations, "invalid_count")
  const payoutCount = integer(input.payouts, "payout_count")
  const payoutConfirmedCents = integer(input.payouts, "confirmed_cents")
  const invalidPayouts = integer(input.payouts, "invalid_count")
  const expectedIdempotencyKey = `rehearsal-baseline:${input.campaignId}`

  if (
    requiredString(input.campaign, "creation_idempotency_key") !== expectedIdempotencyKey
    || requiredString(input.campaign, "status") !== "ended"
    || fundedCents <= 0
    || creditedCents !== fundedCents
    || paidCents !== fundedCents
    || reservedCents !== 0
    || refundedCents !== 0
    || input.realFundingEffects !== 0
    || reservationCount <= 0
    || reservationCreditedCents !== fundedCents
    || invalidReservations !== 0
    || payoutCount <= 0
    || payoutConfirmedCents !== paidCents
    || invalidPayouts !== 0
    || input.activePoolRows !== 0
    || input.otherOpenIncidents !== 0
  ) {
    throw new Error(`fixture_archive_invariants_failed:${input.campaignId}`)
  }

  return {
    creation_idempotency_key: expectedIdempotencyKey,
    campaign_status: "ended",
    funded_cents: fundedCents,
    credited_cents: creditedCents,
    paid_cents: paidCents,
    real_funding_effect_count: input.realFundingEffects,
    reservation_count: reservationCount,
    confirmed_payout_count: payoutCount,
    active_pool_rows: input.activePoolRows,
    other_open_incidents: input.otherOpenIncidents,
  }
}

export async function archiveRehearsalFixtureCampaign(input: {
  client: Client
  campaignId: string
  apply: boolean
  now?: string
}): Promise<RehearsalFixtureArchiveResult> {
  if (!CAMPAIGN_ID_RE.test(input.campaignId)) throw new Error("fixture_archive_invalid_campaign_id")
  const now = input.now ?? new Date().toISOString()
  if (!Number.isFinite(Date.parse(now))) throw new Error("fixture_archive_invalid_now")

  return withTransaction(input.client, input.apply ? "write" : "read", async (tx) => {
    const campaign = await first(tx, `
      SELECT creation_idempotency_key, status, funded_cents, reserved_cents,
        credited_cents, paid_cents, refunded_cents
      FROM reward_campaigns
      WHERE reward_campaign_id = ?1
      ${input.apply ? "FOR UPDATE" : ""}
    `, [input.campaignId])
    if (!campaign) throw new Error(`fixture_archive_campaign_not_found:${input.campaignId}`)

    const realFundingEffects = integer(await first(tx, `
      SELECT COUNT(*) AS count
      FROM reward_campaign_funding_effects
      WHERE reward_campaign_id = ?1
    `, [input.campaignId]), "count")
    const reservations = await first(tx, `
      SELECT
        COUNT(*) AS reservation_count,
        COALESCE(SUM(CASE WHEN status = 'credited' THEN amount_cents ELSE 0 END), 0) AS credited_cents,
        SUM(CASE WHEN status <> 'credited' THEN 1 ELSE 0 END) AS invalid_count
      FROM reward_campaign_reservations
      WHERE reward_campaign_id = ?1
    `, [input.campaignId]) as QueryResultRow
    const payouts = await first(tx, `
      SELECT
        COUNT(DISTINCT payout.reward_payout_effect_id) AS payout_count,
        COALESCE(SUM(CASE WHEN allocation.status = 'confirmed' THEN allocation.amount_cents ELSE 0 END), 0)
          AS confirmed_cents,
        SUM(CASE
          WHEN allocation.status <> 'confirmed'
            OR payout.status <> 'confirmed'
            OR payout.coordinator_state <> 'confirmed'
          THEN 1 ELSE 0 END) AS invalid_count
      FROM reward_payout_allocations allocation
      JOIN reward_payout_effects payout
        ON payout.reward_payout_effect_id = allocation.reward_payout_effect_id
      WHERE allocation.reward_campaign_id = ?1
    `, [input.campaignId]) as QueryResultRow
    const activePoolRows = integer(await first(tx, `
      SELECT COUNT(*) AS count FROM reward_song_pools WHERE reward_campaign_id = ?1
    `, [input.campaignId]), "count")
    const otherOpenIncidents = integer(await first(tx, `
      SELECT COUNT(*) AS count
      FROM reward_campaign_incidents
      WHERE reward_campaign_id = ?1
        AND resolved_at IS NULL
        AND incident_kind <> 'accounting_mismatch'
    `, [input.campaignId]), "count")
    const evidence = requireFixtureShape({
      campaignId: input.campaignId,
      campaign,
      realFundingEffects,
      reservations,
      payouts,
      activePoolRows,
      otherOpenIncidents,
    })

    const existingArchive = await first(tx, `
      SELECT archive_reason FROM reward_campaign_fixture_archives WHERE reward_campaign_id = ?1
    `, [input.campaignId])
    if (existingArchive) {
      if (requiredString(existingArchive, "archive_reason") !== REHEARSAL_FIXTURE_ARCHIVE_REASON) {
        throw new Error(`fixture_archive_reason_conflict:${input.campaignId}`)
      }
      return {
        campaign_id: input.campaignId,
        outcome: "already_archived",
        archive_reason: REHEARSAL_FIXTURE_ARCHIVE_REASON,
        evidence,
      }
    }
    if (!input.apply) {
      return {
        campaign_id: input.campaignId,
        outcome: "eligible",
        archive_reason: REHEARSAL_FIXTURE_ARCHIVE_REASON,
        evidence,
      }
    }

    await tx.execute({
      sql: `
        INSERT INTO reward_campaign_fixture_funding_effects (
          reward_campaign_fixture_funding_effect_id, reward_campaign_id,
          fixture_kind, amount_cents, recorded_by, recorded_at, evidence_json
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
      `,
      args: [
        rehearsalFixtureFundingEffectId(input.campaignId),
        input.campaignId,
        REHEARSAL_FIXTURE_KIND,
        evidence.funded_cents,
        ARCHIVE_ACTOR,
        now,
        JSON.stringify(evidence),
      ],
    })
    await tx.execute({
      sql: `
        INSERT INTO reward_campaign_fixture_archives (
          reward_campaign_id, archive_reason, archived_by, archived_at, evidence_json
        ) VALUES (?1, ?2, ?3, ?4, ?5)
      `,
      args: [
        input.campaignId,
        REHEARSAL_FIXTURE_ARCHIVE_REASON,
        ARCHIVE_ACTOR,
        now,
        JSON.stringify(evidence),
      ],
    })
    await tx.execute({
      sql: `
        UPDATE reward_campaign_incidents
        SET resolved_at = ?2, resolved_by = ?3, resolution_note = ?4,
          incident_version = incident_version + 1
        WHERE reward_campaign_id = ?1
          AND resolved_at IS NULL
          AND incident_kind = 'accounting_mismatch'
      `,
      args: [input.campaignId, now, ARCHIVE_ACTOR, REHEARSAL_FIXTURE_ARCHIVE_REASON],
    })
    const reconciliation = await first(tx, `
      SELECT counters_match
      FROM reward_campaign_accounting_reconciliation
      WHERE reward_campaign_id = ?1
    `, [input.campaignId])
    if (rowValue(reconciliation, "counters_match") !== true) {
      throw new Error(`fixture_archive_reconciliation_failed:${input.campaignId}`)
    }

    return {
      campaign_id: input.campaignId,
      outcome: "archived",
      archive_reason: REHEARSAL_FIXTURE_ARCHIVE_REASON,
      evidence,
    }
  })
}
