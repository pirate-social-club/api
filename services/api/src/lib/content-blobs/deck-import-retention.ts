import type { Env } from "../../env"
import { executeFirst } from "../db-helpers"
import { nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { openCommunityReadClient } from "../communities/community-read-access"
import type { CommunityDatabaseBindingRepository } from "../communities/db-community-repository"
import { deleteContentSource } from "./content-source-broker-client"

/** The raw CSV remains available for seven days after a completed import. */
export const DECK_IMPORT_PLAINTEXT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
export const DECK_IMPORT_RETENTION_SWEEP_LIMIT = 50

type DeckImportRetentionState = "active" | "purge_pending"

type DeckImportCandidate = {
  contentBlobId: string
  communityId: string
  claimRef: string
  retentionState: DeckImportRetentionState
  verifiedContentHash: string | null
  verifiedSizeBytes: number | null
  claimedAt: string
}

export type DeckImportRetentionSummary = {
  candidates: number
  communities: number
  committed: number
  markedPurgePending: number
  purged: number
  deferred: number
  errors: number
}

/**
 * The claim reference is deliberately durable and contains no CSV contents:
 * `${learning_deck_id}:${sha256(import bytes + mapping)}`.
 */
export function parseDeckImportClaimRef(value: string): { deckId: string; importKey: string } | null {
  const match = /^([^:]{1,128}):([a-f0-9]{64})$/u.exec(value.trim())
  if (!match) return null
  return { deckId: match[1]!, importKey: match[2]! }
}

function retentionCutoff(now: string): string {
  const timestamp = Date.parse(now)
  if (!Number.isFinite(timestamp)) throw new RangeError("retention sweep time must be a valid ISO timestamp")
  return new Date(timestamp - DECK_IMPORT_PLAINTEXT_RETENTION_MS).toISOString()
}

function rowString(row: unknown, key: string): string | null {
  const value = (row as Record<string, unknown> | undefined)?.[key]
  return typeof value === "string" && value.length > 0 ? value : null
}

function rowNumber(row: unknown, key: string): number | null {
  const value = (row as Record<string, unknown> | undefined)?.[key]
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function rowBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1"
}

function importRowCount(detailsJson: string | null): number | null {
  if (!detailsJson) return null
  try {
    const parsed = JSON.parse(detailsJson) as Record<string, unknown>
    const count = typeof parsed.row_count === "number" ? parsed.row_count : Number(parsed.row_count)
    return Number.isSafeInteger(count) && count > 0 ? count : null
  } catch {
    return null
  }
}

/**
 * A durable preview event plus a complete set of deterministic card IDs is
 * the commit marker. This avoids deleting an import after a claim was made but
 * before a card transaction completed, while still allowing cleanup when the
 * creator leaves a draft untouched.
 */
async function hasCommittedDeckImport(input: {
  client: Parameters<typeof executeFirst>[0]
  candidate: DeckImportCandidate
  deckId: string
  importKey: string
}): Promise<boolean> {
  const event = await executeFirst(input.client, {
    sql: `
      SELECT events.details_json
      FROM community_job_events AS events
      JOIN community_jobs AS jobs ON jobs.job_id = events.job_id
      WHERE jobs.job_type = 'learning_deck_import_parse'
        AND jobs.subject_type = 'content_blob'
        AND jobs.subject_id = ?1
        AND jobs.status = 'succeeded'
        AND events.checkpoint = 'learning_deck_import_preview_ready'
      ORDER BY events.created_at DESC, events.event_id DESC
      LIMIT 1
    `,
    args: [input.candidate.contentBlobId],
  })
  const expectedRows = importRowCount(rowString(event, "details_json"))
  if (expectedRows == null) return false

  const prefix = `lcd_${input.importKey.slice(0, 24)}_`
  const cards = await executeFirst(input.client, {
    sql: `
      SELECT
        EXISTS (
          SELECT 1 FROM learning_decks
          WHERE learning_deck_id = ?1
        ) AS deck_exists,
        COUNT(*) AS imported_card_count
      FROM learning_cards
      WHERE learning_deck_id = ?1
        AND learning_card_id LIKE ?2
    `,
    args: [input.deckId, `${prefix}%`],
  })
  return rowBoolean((cards as Record<string, unknown> | undefined)?.deck_exists)
    && rowNumber(cards, "imported_card_count") === expectedRows
}

async function listCandidates(input: {
  control: Parameters<typeof executeFirst>[0]
  cutoff: string
  limit: number
}): Promise<DeckImportCandidate[]> {
  const result = await input.control.execute({
    sql: `
      SELECT content_blob_id, community_id, claim_ref,
             plaintext_retention_state, verified_content_hash,
             verified_size_bytes, claimed_at
      FROM content_blobs
      WHERE claim_kind = 'deck_import'
        AND plaintext_retention_state IN ('active', 'purge_pending')
        AND claimed_at IS NOT NULL
        AND claimed_at <= ?1
      ORDER BY claimed_at ASC, content_blob_id ASC
      LIMIT ?2
    `,
    args: [input.cutoff, input.limit],
  })
  return result.rows.flatMap((row): DeckImportCandidate[] => {
    const contentBlobId = rowString(row, "content_blob_id")
    const communityId = rowString(row, "community_id")
    const claimRef = rowString(row, "claim_ref")
    const claimedAt = rowString(row, "claimed_at")
    const retentionState = rowString(row, "plaintext_retention_state")
    if (
      !contentBlobId
      || !communityId
      || !claimRef
      || !claimedAt
      || (retentionState !== "active" && retentionState !== "purge_pending")
    ) return []
    return [{
      contentBlobId,
      communityId,
      claimRef,
      retentionState,
      verifiedContentHash: rowString(row, "verified_content_hash"),
      verifiedSizeBytes: rowNumber(row, "verified_size_bytes"),
      claimedAt,
    }]
  })
}

export async function reconcileDeckImportPlaintextRetention(input: {
  env: Env
  repository: CommunityDatabaseBindingRepository
  now?: string
  limit?: number
}): Promise<DeckImportRetentionSummary> {
  const now = input.now ?? nowIso()
  const summary: DeckImportRetentionSummary = {
    candidates: 0,
    communities: 0,
    committed: 0,
    markedPurgePending: 0,
    purged: 0,
    deferred: 0,
    errors: 0,
  }
  const control = getControlPlaneClient(input.env)
  const candidates = await listCandidates({
    control,
    cutoff: retentionCutoff(now),
    limit: Math.max(1, Math.min(DECK_IMPORT_RETENTION_SWEEP_LIMIT, Math.trunc(input.limit ?? DECK_IMPORT_RETENTION_SWEEP_LIMIT))),
  })
  summary.candidates = candidates.length
  const openedCommunities = new Set<string>()
  for (const candidate of candidates) {
    const parsedRef = parseDeckImportClaimRef(candidate.claimRef)
    if (!parsedRef) {
      summary.deferred += 1
      continue
    }

    let committed = candidate.retentionState === "purge_pending"
    let db: Awaited<ReturnType<typeof openCommunityReadClient>> | null = null
    try {
      if (!committed) {
        db = await openCommunityReadClient(input.env, input.repository, candidate.communityId)
        openedCommunities.add(candidate.communityId)
        committed = await hasCommittedDeckImport({
          client: db.client,
          candidate,
          deckId: parsedRef.deckId,
          importKey: parsedRef.importKey,
        })
      }
      if (!committed) {
        summary.deferred += 1
        continue
      }
      summary.committed += 1

      const pending = await control.execute({
        sql: `
          UPDATE content_blobs
          SET plaintext_retention_state = 'purge_pending', updated_at = ?1
          WHERE content_blob_id = ?2
            AND plaintext_retention_state = 'active'
        `,
        args: [now, candidate.contentBlobId],
      })
      if ((pending.rowsAffected ?? 0) === 1) summary.markedPurgePending += 1

      const current = await executeFirst(control, {
        sql: `
          SELECT plaintext_retention_state, verified_content_hash, verified_size_bytes
          FROM content_blobs
          WHERE content_blob_id = ?1
          LIMIT 1
        `,
        args: [candidate.contentBlobId],
      })
      const state = rowString(current, "plaintext_retention_state")
      const hash = rowString(current, "verified_content_hash")
      const size = rowNumber(current, "verified_size_bytes")
      if (state !== "purge_pending" || !hash || size == null) {
        summary.deferred += 1
        continue
      }

      await deleteContentSource({
        env: input.env,
        contentBlobId: candidate.contentBlobId,
        expectedSizeBytes: size,
        expectedSha256: hash,
      })
      const purged = await control.execute({
        sql: `
          UPDATE content_blobs
          SET plaintext_retention_state = 'purged', plaintext_purged_at = ?1,
              updated_at = ?1
          WHERE content_blob_id = ?2
            AND plaintext_retention_state = 'purge_pending'
        `,
        args: [now, candidate.contentBlobId],
      })
      if ((purged.rowsAffected ?? 0) === 1) summary.purged += 1
      else summary.deferred += 1
    } catch (error) {
      summary.errors += 1
      console.warn("[deck-import-retention] source purge deferred", {
        content_blob_id: candidate.contentBlobId,
        error_class: error instanceof Error ? error.name : "unknown",
      })
    } finally {
      db?.close()
    }
  }
  summary.communities = openedCommunities.size
  console.info("[deck-import-retention] sweep", summary)
  return summary
}
