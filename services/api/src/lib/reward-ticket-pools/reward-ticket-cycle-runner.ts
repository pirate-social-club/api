import { createHash, randomUUID } from "node:crypto"
import type { Client } from "../sql-client"

export type RewardTicketCycleStatus =
  | "planned" | "freezing" | "publishing" | "purchasing" | "drawing_pending"
  | "sweeping" | "claiming" | "crediting" | "completed" | "paused"
  | "recovery_required" | "failed"

export type RewardTicketCycle = Readonly<{
  cycleId: string
  scheduleKey: string
  chainId: number
  jackpotAddress: string
  drawingId: bigint
  status: RewardTicketCycleStatus
  runnerVersion: string
  sourceCommit: string
  scheduledFor: string
  leaseOwner: string | null
  leaseExpiresAt: string | null
}>

export type RewardTicketCycleEvidenceKind =
  | "cycle_started" | "beneficiaries_frozen" | "commitment_published"
  | "tickets_purchased" | "drawing_observed" | "claim_observed"
  | "allocation_credited" | "solvency_observed" | "pause_drill"
  | "crash_restart_drill" | "recovery_drill" | "cycle_completed" | "alert"

export type RewardTicketCycleClientFactory = () => Client | Promise<Client>

function rowValue(row: Record<string, unknown>, key: string): unknown {
  return row[key]
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = rowValue(row, key)
  if (value === null || value === undefined || String(value).trim() === "") {
    throw new Error(`reward ticket cycle row is missing ${key}`)
  }
  return String(value)
}

function cycleFromRow(row: Record<string, unknown>): RewardTicketCycle {
  const chainId = Number(rowValue(row, "chain_id"))
  if (!Number.isSafeInteger(chainId) || chainId !== 84532) throw new Error("reward ticket cycle chain is invalid")
  return {
    cycleId: requiredString(row, "reward_ticket_automation_cycle_id"),
    scheduleKey: requiredString(row, "schedule_key"),
    chainId,
    jackpotAddress: requiredString(row, "jackpot_address"),
    drawingId: BigInt(requiredString(row, "drawing_id")),
    status: requiredString(row, "status") as RewardTicketCycleStatus,
    runnerVersion: requiredString(row, "runner_version"),
    sourceCommit: requiredString(row, "source_commit"),
    scheduledFor: requiredString(row, "scheduled_for"),
    leaseOwner: rowValue(row, "lease_owner") === null ? null : String(rowValue(row, "lease_owner")),
    leaseExpiresAt: rowValue(row, "lease_expires_at") === null ? null : String(rowValue(row, "lease_expires_at")),
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
}

export function hashRewardTicketCycleEvidence(input: Readonly<{
  cycleId: string
  sequenceNumber: number
  kind: RewardTicketCycleEvidenceKind
  evidence: Readonly<Record<string, unknown>>
  observedAt: string
}>): string {
  const payload = canonical(input)
  return createHash("sha256").update(payload).digest("hex")
}

export class RewardTicketCycleRunner {
  constructor(private readonly clientFactory: RewardTicketCycleClientFactory) {}

  private async withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = await this.clientFactory()
    try { return await fn(client) } finally { await client.close?.() }
  }

  async claimDue(input: Readonly<{ owner: string; now: string; leaseMs: number }>): Promise<RewardTicketCycle | null> {
    const leaseUntil = new Date(Date.parse(input.now) + input.leaseMs).toISOString()
    return this.withClient(async (client) => {
      const result = await client.execute({
        sql: `
          WITH candidate AS (
            SELECT reward_ticket_automation_cycle_id
            FROM reward_ticket_automation_cycles
            WHERE scheduled_for <= ?1
              AND status IN ('planned', 'freezing', 'publishing', 'purchasing',
                             'drawing_pending', 'sweeping', 'claiming', 'crediting',
                             'recovery_required')
              AND (lease_expires_at IS NULL OR lease_expires_at <= ?1)
            ORDER BY scheduled_for, reward_ticket_automation_cycle_id
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          )
          UPDATE reward_ticket_automation_cycles AS cycle
          SET lease_owner = ?2, lease_expires_at = ?3,
              heartbeat_at = ?1, updated_at = ?1,
              started_at = COALESCE(started_at, ?1)
          FROM candidate
          WHERE cycle.reward_ticket_automation_cycle_id = candidate.reward_ticket_automation_cycle_id
          RETURNING cycle.*
        `,
        args: [input.now, input.owner, leaseUntil],
      })
      return result.rows.length === 0 ? null : cycleFromRow(result.rows[0] as Record<string, unknown>)
    })
  }

  async heartbeat(input: Readonly<{ cycleId: string; owner: string; now: string; leaseMs: number }>): Promise<void> {
    const leaseUntil = new Date(Date.parse(input.now) + input.leaseMs).toISOString()
    await this.withClient(async (client) => {
      const result = await client.execute({
        sql: `UPDATE reward_ticket_automation_cycles
              SET heartbeat_at = ?3, lease_expires_at = ?4, updated_at = ?3
              WHERE reward_ticket_automation_cycle_id = ?1 AND lease_owner = ?2
                AND lease_expires_at > ?3`,
        args: [input.cycleId, input.owner, input.now, leaseUntil],
      })
      if ((result.rowsAffected ?? 0) !== 1) throw new Error("reward ticket cycle lease was lost")
    })
  }

  async transition(input: Readonly<{
    cycleId: string
    owner: string
    from: RewardTicketCycleStatus | readonly RewardTicketCycleStatus[]
    to: RewardTicketCycleStatus
    now: string
    failureReason?: string
  }>): Promise<void> {
    const from = Array.isArray(input.from) ? input.from : [input.from]
    const placeholders = from.map((_status, index) => `?${index + 4}`).join(", ")
    await this.withClient(async (client) => {
      const result = await client.execute({
        sql: `UPDATE reward_ticket_automation_cycles
              SET status = ?3, failure_reason = ?${from.length + 4}, updated_at = ?${from.length + 5},
                  completed_at = CASE WHEN ?3 = 'completed' THEN ?${from.length + 5} ELSE NULL END
              WHERE reward_ticket_automation_cycle_id = ?1 AND lease_owner = ?2
                AND status IN (${placeholders})`,
        args: [input.cycleId, input.owner, input.to, ...from, input.failureReason ?? null, input.now],
      })
      if ((result.rowsAffected ?? 0) !== 1) throw new Error("reward ticket cycle transition was rejected")
    })
  }

  async appendEvidence(input: Readonly<{
    cycleId: string
    owner: string
    kind: RewardTicketCycleEvidenceKind
    evidence: Readonly<Record<string, unknown>>
    observedAt: string
  }>): Promise<string> {
    return this.withClient(async (client) => {
      const tx = await client.transaction("write")
      try {
        const lease = await tx.execute({
          sql: `SELECT reward_ticket_automation_cycle_id
                FROM reward_ticket_automation_cycles
                WHERE reward_ticket_automation_cycle_id = ?1 AND lease_owner = ?2
                  AND lease_expires_at > NOW()
                FOR UPDATE`,
          args: [input.cycleId, input.owner],
        })
        if (lease.rows.length !== 1) throw new Error("reward ticket cycle lease was lost")
        const latest = await tx.execute({
          sql: `SELECT COALESCE(MAX(sequence_number), -1) + 1 AS next_sequence
                FROM reward_ticket_automation_evidence
                WHERE reward_ticket_automation_cycle_id = ?1`,
          args: [input.cycleId],
        })
        const sequenceNumber = Number((latest.rows[0] as Record<string, unknown> | undefined)?.next_sequence)
        if (!Number.isSafeInteger(sequenceNumber) || sequenceNumber < 0) throw new Error("reward ticket evidence sequence is invalid")
        const evidenceHash = hashRewardTicketCycleEvidence({ ...input, sequenceNumber })
        await tx.execute({
          sql: `INSERT INTO reward_ticket_automation_evidence (
                reward_ticket_automation_evidence_id, reward_ticket_automation_cycle_id,
                sequence_number, evidence_kind, evidence_json, evidence_hash, observed_at
              ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
          args: [`rtae_${randomUUID()}`, input.cycleId, sequenceNumber, input.kind,
            JSON.stringify(input.evidence), evidenceHash, input.observedAt],
        })
        await tx.commit()
        return evidenceHash
      } catch (error) {
        await tx.rollback().catch(() => {})
        throw error
      } finally { tx.close() }
    })
  }

  async release(input: Readonly<{ cycleId: string; owner: string; now: string }>): Promise<void> {
    await this.withClient(async (client) => {
      await client.execute({
        sql: `UPDATE reward_ticket_automation_cycles
              SET lease_owner = NULL, lease_expires_at = NULL, updated_at = ?3
              WHERE reward_ticket_automation_cycle_id = ?1 AND lease_owner = ?2`,
        args: [input.cycleId, input.owner, input.now],
      })
    })
  }

  async runOne(input: Readonly<{
    owner: string
    now: string
    leaseMs: number
    execute: (cycle: RewardTicketCycle, runner: RewardTicketCycleRunner) => Promise<void>
  }>): Promise<"idle" | "completed" | "recovery_required"> {
    const cycle = await this.claimDue(input)
    if (!cycle) return "idle"
    try {
      await this.appendEvidence({ cycleId: cycle.cycleId, owner: input.owner, kind: "cycle_started", evidence: { status: cycle.status }, observedAt: input.now })
      await input.execute(cycle, this)
      await this.transition({ cycleId: cycle.cycleId, owner: input.owner, from: cycle.status, to: "completed", now: input.now })
      await this.appendEvidence({ cycleId: cycle.cycleId, owner: input.owner, kind: "cycle_completed", evidence: {}, observedAt: input.now })
      return "completed"
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      await this.appendEvidence({ cycleId: cycle.cycleId, owner: input.owner, kind: "alert", evidence: { reason }, observedAt: input.now }).catch(() => {})
      await this.transition({ cycleId: cycle.cycleId, owner: input.owner, from: cycle.status, to: "recovery_required", now: input.now, failureReason: reason }).catch(() => {})
      return "recovery_required"
    } finally {
      await this.release({ cycleId: cycle.cycleId, owner: input.owner, now: input.now }).catch(() => {})
    }
  }
}
