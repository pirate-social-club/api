import type { Env } from "../../env"
import type { Client, QueryResultRow, Transaction } from "../sql-client"
import { withTransaction } from "../transactions"
import {
  observeHnsRootAuthority,
  type HnsRootAuthorityObservation,
} from "../verification/hns-verifier"

// A verifier request may consume its full 12-second timeout. Four roots keep a
// worst-case sweep inside the scheduler's 55-second start budget and allow the
// cluster-wide cron lease to remain authoritative for the entire batch.
const DEFAULT_BATCH_SIZE = 4
const DEFAULT_INTERVAL_SECONDS = 300
const OBSERVATION_PROVIDER = "hns_verifier_bind_delv"

type DelegationSecurity = "unsecured" | "secure" | "bogus" | "drifted"

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function isHnsRootObserverEnabled(env: Env): boolean {
  return env.HNS_ROOT_OBSERVER_ENABLED?.trim() === "true"
}

function text(row: QueryResultRow | undefined, key: string): string | null {
  const value = row?.[key]
  return typeof value === "string" && value.trim() ? value : null
}

function boolInt(value: boolean): number {
  return value ? 1 : 0
}

function observationId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`
}

async function evidenceHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

function deriveDelegationSecurity(input: {
  parentMatches: boolean
  authoritativeValid: boolean
  previous: string | null
}): DelegationSecurity {
  if (input.parentMatches && input.authoritativeValid) return "secure"
  if (input.parentMatches) return "bogus"
  return input.previous === "secure" ? "drifted" : "unsecured"
}

async function loadPreviousSecurity(
  tx: Pick<Transaction, "execute">,
  rootLabel: string,
): Promise<string | null> {
  const result = await tx.execute({
    sql: `
      SELECT observation.observed_delegation_security
      FROM hns_root_delegation_state AS state
      LEFT JOIN hns_root_parent_observations AS observation
        ON observation.parent_observation_id = state.last_parent_observation_id
      WHERE state.normalized_root_label = ?1
      LIMIT 1
    `,
    args: [rootLabel],
  })
  return text(result.rows[0], "observed_delegation_security")
}

async function loadIssuedDs(
  tx: Pick<Transaction, "execute">,
  rootLabel: string,
): Promise<Map<string, string>> {
  const result = await tx.execute({
    sql: `
      SELECT issued_ds_id, key_tag, algorithm, digest_type, digest
      FROM hns_root_issued_ds
      WHERE normalized_root_label = ?1
    `,
    args: [rootLabel],
  })
  return new Map(result.rows.flatMap((row) => {
    const issuedDsId = text(row, "issued_ds_id")
    const keyTag = Number(row.key_tag)
    const algorithm = Number(row.algorithm)
    const digestType = Number(row.digest_type)
    const digest = text(row, "digest")?.toLowerCase()
    return issuedDsId && Number.isSafeInteger(keyTag) && Number.isSafeInteger(algorithm)
      && Number.isSafeInteger(digestType) && digest
      ? [[`${keyTag}:${algorithm}:${digestType}:${digest}`, issuedDsId]]
      : []
  }))
}

async function persistSuccessfulObservation(
  client: Client,
  observation: HnsRootAuthorityObservation,
  now: string,
): Promise<void> {
  await withTransaction(client, "write", async (tx) => {
    const rootLabel = observation.root_label
    const previousSecurity = await loadPreviousSecurity(tx, rootLabel)
    const issuedDs = await loadIssuedDs(tx, rootLabel)
    const authoritativeValid = observation.authoritative_dnssec_valid
      && observation.earliest_rrsig_expires_at != null
    const security = deriveDelegationSecurity({
      parentMatches: observation.parent_ds_matches_live_dnskey,
      authoritativeValid,
      previous: previousSecurity,
    })
    const parentObservationId = observationId("hrp")
    const redundancyObservationId = observationId("hrr")
    const rawResponse = JSON.stringify(observation)

    await tx.execute({
      sql: `
        INSERT INTO hns_root_parent_observations (
          parent_observation_id,
          normalized_root_label,
          outcome,
          provider,
          failure_code,
          observed_delegation_security,
          parent_ds_matches_live_dnskey,
          authoritative_dnssec_valid,
          earliest_rrsig_expires_at,
          raw_response_json,
          evidence_hash,
          observed_at,
          created_at
        ) VALUES (?1, ?2, 'succeeded', ?3, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
      `,
      args: [
        parentObservationId,
        rootLabel,
        observation.provider || OBSERVATION_PROVIDER,
        security,
        boolInt(observation.parent_ds_matches_live_dnskey),
        boolInt(authoritativeValid),
        observation.earliest_rrsig_expires_at,
        rawResponse,
        await evidenceHash(observation),
        observation.observed_at,
      ],
    })

    for (const parentDs of observation.parent_ds_results) {
      const key = `${parentDs.key_tag}:${parentDs.algorithm}:${parentDs.digest_type}:${parentDs.digest.toLowerCase()}`
      const issuedDsId = issuedDs.get(key) ?? null
      const classification = issuedDsId == null || parentDs.matches_live_dnskey == null
        ? "unverifiable"
        : parentDs.matches_live_dnskey
          ? "matching"
          : "orphaned"
      await tx.execute({
        sql: `
          INSERT INTO hns_root_observed_ds (
            observed_ds_id,
            parent_observation_id,
            normalized_root_label,
            key_tag,
            algorithm,
            digest_type,
            digest,
            classification,
            matched_issued_ds_id,
            created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        `,
        args: [
          observationId("hod"),
          parentObservationId,
          rootLabel,
          parentDs.key_tag,
          parentDs.algorithm,
          parentDs.digest_type,
          parentDs.digest.toLowerCase(),
          classification,
          classification === "unverifiable" ? null : issuedDsId,
          now,
        ],
      })
    }

    await tx.execute({
      sql: `
        INSERT INTO hns_root_redundancy_observations (
          redundancy_observation_id,
          normalized_root_label,
          outcome,
          provider,
          failure_code,
          observed_parent_ns_json,
          authority_redundancy_ok,
          observed_at,
          created_at
        ) VALUES (?1, ?2, 'succeeded', ?3, NULL, ?4, ?5, ?6, ?7)
      `,
      args: [
        redundancyObservationId,
        rootLabel,
        observation.provider || OBSERVATION_PROVIDER,
        JSON.stringify(observation.parent.nameservers),
        boolInt(observation.authority_redundancy_ok),
        observation.observed_at,
        now,
      ],
    })
    for (const authority of observation.authorities) {
      await tx.execute({
        sql: `
          INSERT INTO hns_root_redundancy_authority_observations (
            redundancy_authority_observation_id,
            redundancy_observation_id,
            normalized_root_label,
            redundancy_observation_outcome,
            nameserver,
            reachable,
            soa_serial,
            serial_in_sync,
            failure_code,
            created_at
          ) VALUES (?1, ?2, ?3, 'succeeded', ?4, ?5, ?6, ?7, ?8, ?9)
        `,
        args: [
          observationId("hra"),
          redundancyObservationId,
          rootLabel,
          authority.nameserver,
          boolInt(authority.reachable),
          authority.soa_serial,
          authority.serial_in_sync == null ? null : boolInt(authority.serial_in_sync),
          authority.failure_code,
          now,
        ],
      })
    }

    const stateChangedAt = previousSecurity === security ? null : now
    await tx.execute({
      sql: `
        UPDATE hns_root_delegation_state
        SET last_parent_observation_id = ?2,
            last_parent_observation_outcome = 'succeeded',
            last_parent_observation_attempt_at = ?3,
            authority_redundancy_ok = ?4,
            last_redundancy_observation_id = ?5,
            last_redundancy_observation_outcome = 'succeeded',
            last_redundancy_observation_at = ?3,
            last_redundancy_observation_attempt_at = ?3,
            state_changed_at = COALESCE(?6, state_changed_at),
            updated_at = ?7
        WHERE normalized_root_label = ?1
      `,
      args: [
        rootLabel,
        parentObservationId,
        observation.observed_at,
        boolInt(observation.authority_redundancy_ok),
        redundancyObservationId,
        stateChangedAt,
        now,
      ],
    })
  })
}

async function persistFailedObservation(
  client: Client,
  rootLabel: string,
  now: string,
  failureCode: string,
): Promise<void> {
  await withTransaction(client, "write", async (tx) => {
    await tx.execute({
      sql: `
        INSERT INTO hns_root_parent_observations (
          parent_observation_id, normalized_root_label, outcome, provider,
          failure_code, observed_at, created_at
        ) VALUES (?1, ?2, 'failed', ?3, ?4, ?5, ?5)
      `,
      args: [observationId("hrp"), rootLabel, OBSERVATION_PROVIDER, failureCode, now],
    })
    await tx.execute({
      sql: `
        INSERT INTO hns_root_redundancy_observations (
          redundancy_observation_id, normalized_root_label, outcome, provider,
          failure_code, observed_at, created_at
        ) VALUES (?1, ?2, 'failed', ?3, ?4, ?5, ?5)
      `,
      args: [observationId("hrr"), rootLabel, OBSERVATION_PROVIDER, failureCode, now],
    })
    await tx.execute({
      sql: `
        UPDATE hns_root_delegation_state
        SET last_parent_observation_attempt_at = ?2,
            last_redundancy_observation_attempt_at = ?2,
            updated_at = ?2
        WHERE normalized_root_label = ?1
      `,
      args: [rootLabel, now],
    })
  })
}

function failureCode(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : ""
  if (message.includes("timed out")) return "verifier_timeout"
  if (message.includes("not configured")) return "verifier_not_configured"
  return "verifier_observation_failed"
}

function dsIdentity(ds: {
  key_tag: number
  algorithm: number
  digest_type: number
  digest: string
}): string {
  return `${ds.key_tag}:${ds.algorithm}:${ds.digest_type}:${ds.digest.toLowerCase()}`
}

function validateObservation(
  expectedRootLabel: string,
  observation: HnsRootAuthorityObservation,
  now: Date,
): void {
  if (observation.root_label !== expectedRootLabel) {
    throw new Error("verifier observation root mismatch")
  }
  const observedAt = Date.parse(observation.observed_at)
  if (!Number.isFinite(observedAt) || observedAt > now.getTime()) {
    throw new Error("verifier observation timestamp is invalid")
  }
  const parentDs = observation.parent.ds_records.map(dsIdentity).sort()
  const results = observation.parent_ds_results.map(dsIdentity).sort()
  if (parentDs.length !== results.length || parentDs.some((value, index) => value !== results[index])) {
    throw new Error("verifier per-DS results are incomplete")
  }
  if (
    observation.parent_ds_matches_live_dnskey
    !== observation.parent_ds_results.some((result) => result.matches_live_dnskey === true)
  ) {
    throw new Error("verifier parent DS verdict is incoherent")
  }
  if (observation.authoritative_dnssec_valid && observation.earliest_rrsig_expires_at == null) {
    throw new Error("verifier secure authority result lacks RRSIG expiry")
  }
  const parentNameservers = [...new Set(observation.parent.nameservers)].sort()
  const observedAuthorities = [...new Set(
    observation.authorities.map((authority) => authority.nameserver),
  )].sort()
  if (
    parentNameservers.length !== observedAuthorities.length
    || parentNameservers.some((value, index) => value !== observedAuthorities[index])
  ) {
    throw new Error("verifier authority results do not cover the parent NS set")
  }
}

export async function observeDueHnsRoots(
  client: Client,
  env: Env,
  now = new Date(),
): Promise<{ attempted: number; succeeded: number; failed: number }> {
  if (!isHnsRootObserverEnabled(env)) return { attempted: 0, succeeded: 0, failed: 0 }
  const intervalSeconds = positiveInt(
    env.HNS_ROOT_OBSERVER_INTERVAL_SECONDS,
    DEFAULT_INTERVAL_SECONDS,
  )
  const batchSize = positiveInt(env.HNS_ROOT_OBSERVER_BATCH_SIZE, DEFAULT_BATCH_SIZE)
  const dueBefore = new Date(now.getTime() - intervalSeconds * 1_000).toISOString()
  const due = await client.execute({
    sql: `
      SELECT normalized_root_label
      FROM hns_root_delegation_state
      WHERE last_parent_observation_attempt_at IS NULL
         OR last_redundancy_observation_attempt_at IS NULL
         OR last_parent_observation_attempt_at <= ?1
         OR last_redundancy_observation_attempt_at <= ?1
      ORDER BY
        (last_parent_observation_attempt_at IS NOT NULL),
        last_parent_observation_attempt_at,
        normalized_root_label
      LIMIT ?2
    `,
    args: [dueBefore, batchSize],
  })

  let succeeded = 0
  let failed = 0
  for (const row of due.rows) {
    const rootLabel = text(row, "normalized_root_label")
    if (!rootLabel) continue
    const attemptedAt = now.toISOString()
    try {
      const observation = await observeHnsRootAuthority(env, { rootLabel })
      validateObservation(rootLabel, observation, new Date(attemptedAt))
      await persistSuccessfulObservation(client, observation, attemptedAt)
      succeeded += 1
    } catch (error) {
      await persistFailedObservation(client, rootLabel, attemptedAt, failureCode(error))
      failed += 1
    }
  }
  return { attempted: succeeded + failed, succeeded, failed }
}
