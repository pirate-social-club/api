import { conflictError, notFoundError } from "../errors"
import { sha256Hex } from "../crypto"
import { executeFirst, type DbExecutor } from "../db-helpers"
import { makeId, nowIso } from "../helpers"
import type { Client } from "../sql-client"
import { withTransaction } from "../transactions"
import { getActiveEntitlementForBuyer } from "../communities/commerce/queries"
import {
  LEARNING_REVIEW_ALGORITHM,
  LEARNING_REVIEW_PARAMETERS_VERSION,
  reviewLearningCard,
  type ReviewRating,
  type ReviewState,
} from "./review-scheduler"

const SESSION_TTL_MS = 2 * 60 * 60 * 1000
const MAX_SESSION_ITEMS = 100

type DeckAccess = {
  learning_deck_id: string
  learning_deck_version_id: string
  asset_id: string
  creator_user_id: string
  access_mode: "public" | "locked"
  enforcement_state: "active" | "quarantined" | "blocked"
}

type SessionRow = {
  learning_session_id: string
  user_id: string
  scope_kind: "deck" | "community_due"
  scope_ref: string
  status: "active" | "completed" | "expired"
  session_revision: number
  current_item_id: string | null
  item_count: number
  reviewed_count: number
  expires_at: string
  created_at: string
  completed_at: string | null
}

type SessionItemRow = {
  review_item_id: string
  ordinal: number
  status: "pending" | "current" | "revealed" | "reviewed"
  revealed_at: string | null
  reviewed_event_id: string | null
  card_type: "basic" | "cloze"
  prompt: string
  answer: string
  tags: string[]
}

type PersistedReviewState = ReviewState & {
  due_at_ms: number
  last_reviewed_at_ms: number | null
  learning_step_index: number | null
}

export type LearningSessionView = {
  session_id: string
  status: SessionRow["status"]
  session_revision: number
  item_count: number
  reviewed_count: number
  expires_at: string
  current_item: {
    item_id: string
    ordinal: number
    status: "current" | "revealed"
    prompt: string
    card_type: "basic" | "cloze"
    tags: string[]
  } | null
}

export type LearningRevealView = LearningSessionView & {
  answer: string
  current_item: NonNullable<LearningSessionView["current_item"]> & { answer: string }
}

export type LearningRateView = LearningSessionView & {
  replayed: boolean
  rating: ReviewRating
  next_item: LearningSessionView["current_item"]
}

function stringValue(value: unknown, key: string): string {
  const result = (value as Record<string, unknown> | undefined)?.[key]
  if (typeof result !== "string") throw new Error(`Missing learning review column ${key}`)
  return result
}

function nullableString(value: unknown, key: string): string | null {
  const result = (value as Record<string, unknown> | undefined)?.[key]
  return result == null ? null : String(result)
}

function numberValue(value: unknown, key: string): number {
  const result = Number((value as Record<string, unknown> | undefined)?.[key])
  if (!Number.isFinite(result)) throw new Error(`Invalid learning review column ${key}`)
  return result
}

function parseTextDocument(value: string, field: string): string {
  try {
    const parsed = JSON.parse(value) as { type?: unknown; text?: unknown }
    if (parsed.type === "text" && typeof parsed.text === "string") return parsed.text
  } catch {
    // Malformed answer-bearing rows are never served.
  }
  throw conflictError(`Learning card ${field} document is invalid`)
}

function parseTags(value: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw conflictError("Learning card tags document is invalid")
  }
  if (!Array.isArray(parsed) || parsed.some((tag) => typeof tag !== "string")) {
    throw conflictError("Learning card tags document is invalid")
  }
  return parsed
}

function sessionFromRow(value: unknown): SessionRow {
  return {
    learning_session_id: stringValue(value, "learning_session_id"),
    user_id: stringValue(value, "user_id"),
    scope_kind: stringValue(value, "scope_kind") as SessionRow["scope_kind"],
    scope_ref: stringValue(value, "scope_ref"),
    status: stringValue(value, "status") as SessionRow["status"],
    session_revision: numberValue(value, "session_revision"),
    current_item_id: nullableString(value, "current_item_id"),
    item_count: numberValue(value, "item_count"),
    reviewed_count: numberValue(value, "reviewed_count"),
    expires_at: stringValue(value, "expires_at"),
    created_at: stringValue(value, "created_at"),
    completed_at: nullableString(value, "completed_at"),
  }
}

function accessFromRow(value: unknown): DeckAccess {
  return {
    learning_deck_id: stringValue(value, "learning_deck_id"),
    learning_deck_version_id: stringValue(value, "learning_deck_version_id"),
    asset_id: stringValue(value, "asset_id"),
    creator_user_id: stringValue(value, "creator_user_id"),
    access_mode: stringValue(value, "access_mode") as DeckAccess["access_mode"],
    enforcement_state: stringValue(value, "enforcement_state") as DeckAccess["enforcement_state"],
  }
}

async function assertDeckAccess(input: {
  client: DbExecutor
  communityId: string
  deckId: string
  userId: string
}): Promise<DeckAccess> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT d.learning_deck_id, v.learning_deck_version_id, d.creator_user_id,
             a.asset_id, a.access_mode, enforcement.enforcement_state
      FROM learning_decks d
      JOIN learning_deck_versions v
        ON v.learning_deck_id = d.learning_deck_id
       AND v.version = d.published_version
       AND v.status = 'published'
      JOIN assets a
        ON a.asset_id = d.asset_id
       AND a.asset_kind = 'learning_deck'
      LEFT JOIN asset_enforcement enforcement ON enforcement.asset_id = a.asset_id
      WHERE d.community_id = ?1
        AND d.learning_deck_id = ?2
        AND d.status = 'published'
      LIMIT 1
    `,
    args: [input.communityId, input.deckId],
  })
  if (!row) throw notFoundError("Learning deck not found")
  const access = accessFromRow(row)
  if (access.enforcement_state !== "active") throw notFoundError("Learning deck not found")
  if (access.access_mode === "locked" && access.creator_user_id !== input.userId) {
    const entitlement = await getActiveEntitlementForBuyer(
      input.client,
      input.communityId,
      input.userId,
      access.asset_id,
      "asset_access",
    )
    if (!entitlement) throw notFoundError("Learning deck not found")
  }
  return access
}

async function loadSession(client: DbExecutor, sessionId: string, userId: string): Promise<SessionRow> {
  const row = await executeFirst(client, {
    sql: `
      SELECT learning_session_id, user_id, scope_kind, scope_ref, status,
             session_revision, current_item_id, item_count, reviewed_count,
             expires_at, created_at, completed_at
      FROM learning_sessions
      WHERE learning_session_id = ?1 AND user_id = ?2
      LIMIT 1
    `,
    args: [sessionId, userId],
  })
  if (!row) throw notFoundError("Learning session not found")
  return sessionFromRow(row)
}

async function loadSessionItem(client: DbExecutor, sessionId: string, itemId: string): Promise<SessionItemRow> {
  const row = await executeFirst(client, {
    sql: `
      SELECT si.review_item_id, si.ordinal, si.status, si.revealed_at,
             si.reviewed_event_id, cv.card_type, cv.prompt_json, cv.answer_json,
             cv.tags_json
      FROM learning_session_items si
      JOIN learning_review_items ri ON ri.review_item_id = si.review_item_id
      JOIN learning_cards cards ON cards.learning_card_id = ri.subject_ref
      JOIN learning_card_versions cv
        ON cv.learning_card_id = cards.learning_card_id
       AND cv.learning_deck_version_id = (
         SELECT v.learning_deck_version_id
         FROM learning_sessions s
         JOIN learning_decks d ON d.learning_deck_id = s.scope_ref
         JOIN learning_deck_versions v
           ON v.learning_deck_id = d.learning_deck_id
          AND v.version = d.published_version
          AND v.status = 'published'
         WHERE s.learning_session_id = ?1
       )
      WHERE si.learning_session_id = ?1 AND si.review_item_id = ?2
      LIMIT 1
    `,
    args: [sessionId, itemId],
  })
  if (!row) throw conflictError("Learning session item is unavailable")
  return {
    review_item_id: stringValue(row, "review_item_id"),
    ordinal: numberValue(row, "ordinal"),
    status: stringValue(row, "status") as SessionItemRow["status"],
    revealed_at: nullableString(row, "revealed_at"),
    reviewed_event_id: nullableString(row, "reviewed_event_id"),
    card_type: stringValue(row, "card_type") as SessionItemRow["card_type"],
    prompt: parseTextDocument(stringValue(row, "prompt_json"), "prompt"),
    answer: parseTextDocument(stringValue(row, "answer_json"), "answer"),
    tags: parseTags(stringValue(row, "tags_json")),
  }
}

function view(session: SessionRow, item: SessionItemRow | null): LearningSessionView {
  return {
    session_id: session.learning_session_id,
    status: session.status,
    session_revision: session.session_revision,
    item_count: session.item_count,
    reviewed_count: session.reviewed_count,
    expires_at: session.expires_at,
    current_item: item && (item.status === "current" || item.status === "revealed")
      ? {
          item_id: item.review_item_id,
          ordinal: item.ordinal,
          status: item.status,
          prompt: item.prompt,
          card_type: item.card_type,
          tags: item.tags,
        }
      : null,
  }
}

function persistedState(state: ReviewState): PersistedReviewState {
  return {
    ...state,
    due_at_ms: state.dueAtMs,
    last_reviewed_at_ms: state.lastReviewedAtMs,
    learning_step_index: state.learningStepIndex,
  }
}

async function stateHash(state: ReviewState | null): Promise<string | null> {
  if (!state) return null
  return `0x${await sha256Hex(JSON.stringify(persistedState(state)))}`
}

function ratingValue(value: unknown): ReviewRating {
  if (value !== "again" && value !== "hard" && value !== "good" && value !== "easy") {
    throw conflictError("rating must be again, hard, good, or easy")
  }
  return value
}

function assertReviewTime(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw conflictError("reviewed_at_ms must be a non-negative integer")
}

export async function createLearningDeckSession(input: {
  client: Client
  communityId: string
  deckId: string
  userId: string
  nowMs: number
  limit?: number
}): Promise<LearningSessionView> {
  assertReviewTime(input.nowMs)
  const access = await assertDeckAccess(input)
  const now = new Date(input.nowMs).toISOString()
  const expiresAt = new Date(input.nowMs + SESSION_TTL_MS).toISOString()
  const limit = Math.min(MAX_SESSION_ITEMS, Math.max(1, Math.trunc(input.limit ?? MAX_SESSION_ITEMS)))
  const dueRows = await input.client.execute({
    sql: `
      SELECT ri.review_item_id, COALESCE(state.due_at, ?3) AS due_at
      FROM learning_review_items ri
      JOIN learning_cards cards ON cards.learning_card_id = ri.subject_ref
      JOIN learning_card_versions cv
        ON cv.learning_card_id = cards.learning_card_id
       AND cv.learning_deck_version_id = ?2
      LEFT JOIN learning_review_state state
        ON state.review_item_id = ri.review_item_id
       AND state.user_id = ?1
      WHERE ri.item_kind = 'deck_card'
        AND ri.status = 'active'
        AND cards.retired_at IS NULL
        AND (state.review_item_id IS NULL OR state.due_at <= ?3)
      ORDER BY due_at ASC, ri.review_item_id ASC
      LIMIT ${limit}
    `,
    args: [input.userId, access.learning_deck_version_id, now],
  })
  if (dueRows.rows.length === 0) throw conflictError("No learning cards are due")
  const sessionId = makeId("lsn")
  const firstItemId = stringValue(dueRows.rows[0], "review_item_id")
  await withTransaction(input.client, "write", async (tx) => {
    await tx.execute({
      sql: `
        INSERT INTO learning_sessions (
          learning_session_id, user_id, scope_kind, scope_ref, status,
          session_revision, current_item_id, item_count, reviewed_count,
          expires_at, created_at, completed_at
        ) VALUES (?1, ?2, 'deck', ?3, 'active', 1, ?4, ?5, 0, ?6, ?7, NULL)
      `,
      args: [sessionId, input.userId, input.deckId, firstItemId, dueRows.rows.length, expiresAt, now],
    })
    await tx.batch(dueRows.rows.map((dueRow, index) => ({
      sql: `
        INSERT INTO learning_session_items (
          learning_session_id, review_item_id, ordinal, due_at_snapshot,
          status, revealed_at, reviewed_event_id
        ) VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL)
      `,
      args: [sessionId, stringValue(dueRow, "review_item_id"), index, stringValue(dueRow, "due_at") , index === 0 ? "current" : "pending"],
    })), "write")
  })
  const session = await loadSession(input.client, sessionId, input.userId)
  return view(session, await loadSessionItem(input.client, sessionId, firstItemId))
}

export async function getLearningSession(input: {
  client: Client
  communityId: string
  sessionId: string
  userId: string
}): Promise<LearningSessionView> {
  const session = await loadSession(input.client, input.sessionId, input.userId)
  if (session.scope_kind !== "deck") throw notFoundError("Learning session not found")
  await assertDeckAccess({ ...input, deckId: session.scope_ref })
  const item = session.current_item_id ? await loadSessionItem(input.client, input.sessionId, session.current_item_id) : null
  return view(session, item)
}

export async function revealLearningSessionItem(input: {
  client: Client
  communityId: string
  sessionId: string
  userId: string
  expectedSessionRevision: number
}): Promise<LearningRevealView> {
  const session = await loadSession(input.client, input.sessionId, input.userId)
  if (session.scope_kind !== "deck") throw notFoundError("Learning session not found")
  await assertDeckAccess({ ...input, deckId: session.scope_ref })
  if (session.status !== "active" || session.current_item_id == null) throw conflictError("Learning session has no current card")
  if (session.session_revision !== input.expectedSessionRevision) throw conflictError("Learning session changed; reload it")
  const item = await loadSessionItem(input.client, input.sessionId, session.current_item_id)
  if (item.status === "current") {
    await withTransaction(input.client, "write", async (tx) => {
      const changed = await tx.execute({
        sql: `
          UPDATE learning_session_items
          SET status = 'revealed', revealed_at = ?1
          WHERE learning_session_id = ?2 AND review_item_id = ?3 AND status = 'current'
        `,
        args: [nowIso(), input.sessionId, item.review_item_id],
      })
      if ((changed.rowsAffected ?? 0) !== 1) throw conflictError("Learning session changed; reload it")
      const bumped = await tx.execute({
        sql: `
          UPDATE learning_sessions
          SET session_revision = session_revision + 1
          WHERE learning_session_id = ?1 AND user_id = ?2 AND status = 'active' AND session_revision = ?3
        `,
        args: [input.sessionId, input.userId, input.expectedSessionRevision],
      })
      if ((bumped.rowsAffected ?? 0) !== 1) throw conflictError("Learning session changed; reload it")
    })
  } else if (item.status !== "revealed") {
    throw conflictError("Learning session card is not revealable")
  }
  const updated = await loadSession(input.client, input.sessionId, input.userId)
  const revealed = await loadSessionItem(input.client, input.sessionId, item.review_item_id)
  const current = view(updated, revealed)
  if (!current.current_item) throw conflictError("Learning session card is unavailable")
  return { ...current, answer: revealed.answer, current_item: { ...current.current_item, answer: revealed.answer } }
}

export async function rateLearningSessionItem(input: {
  client: Client
  communityId: string
  sessionId: string
  userId: string
  itemId: string
  rating: ReviewRating
  idempotencyKey: string
  expectedSessionRevision: number
  reviewedAtMs: number
}): Promise<LearningRateView> {
  assertReviewTime(input.reviewedAtMs)
  if (!input.idempotencyKey.trim()) throw conflictError("idempotency_key is required")
  const session = await loadSession(input.client, input.sessionId, input.userId)
  if (session.scope_kind !== "deck") throw notFoundError("Learning session not found")
  const access = await assertDeckAccess({ ...input, deckId: session.scope_ref })
  const priorEvent = await executeFirst(input.client, {
    sql: `SELECT learning_review_event_id, rating FROM learning_review_events WHERE user_id = ?1 AND idempotency_key = ?2 LIMIT 1`,
    args: [input.userId, input.idempotencyKey],
  })
  if (priorEvent) {
    const currentSession = await loadSession(input.client, input.sessionId, input.userId)
    const nextItem = currentSession.current_item_id ? await loadSessionItem(input.client, input.sessionId, currentSession.current_item_id) : null
    return {
      ...view(currentSession, nextItem),
      replayed: true,
      rating: ratingValue(stringValue(priorEvent, "rating")),
      next_item: view(currentSession, nextItem).current_item,
    }
  }
  if (session.status !== "active" || session.current_item_id !== input.itemId) throw conflictError("Learning session card is no longer current")
  if (session.session_revision !== input.expectedSessionRevision) throw conflictError("Learning session changed; reload it")
  const item = await loadSessionItem(input.client, input.sessionId, input.itemId)
  if (item.status !== "revealed") throw conflictError("Reveal the learning card before rating it")
  const rating = ratingValue(input.rating)
  const reviewedAt = new Date(input.reviewedAtMs).toISOString()
  const result = await withTransaction(input.client, "write", async (tx) => {
    const existing = await executeFirst(tx, {
      sql: `
        SELECT learning_review_event_id, resulting_state_json, rating
        FROM learning_review_events
        WHERE user_id = ?1 AND idempotency_key = ?2
        LIMIT 1
      `,
      args: [input.userId, input.idempotencyKey],
    })
    if (existing) {
      return { eventId: stringValue(existing, "learning_review_event_id"), replayed: true, stateJson: stringValue(existing, "resulting_state_json"), rating: ratingValue(stringValue(existing, "rating")) }
    }
    const stateRow = await executeFirst(tx, {
      sql: `
        SELECT algorithm, parameters_version, phase, stability, difficulty,
               learning_step, scheduled_interval_days, due_at, last_reviewed_at,
               reps, lapses, revision, last_review_event_id, updated_at
        FROM learning_review_state
        WHERE user_id = ?1 AND review_item_id = ?2
        LIMIT 1
      `,
      args: [input.userId, input.itemId],
    })
    let priorState: ReviewState | null = null
    let priorRevision = 0
    if (stateRow) {
      if (stringValue(stateRow, "algorithm") !== LEARNING_REVIEW_ALGORITHM || numberValue(stateRow, "parameters_version") !== LEARNING_REVIEW_PARAMETERS_VERSION) {
        throw conflictError("Learning review algorithm version is unsupported")
      }
      priorState = {
        phase: stringValue(stateRow, "phase") as ReviewState["phase"],
        stability: numberValue(stateRow, "stability"),
        difficulty: numberValue(stateRow, "difficulty"),
        dueAtMs: Date.parse(stringValue(stateRow, "due_at")),
        lastReviewedAtMs: nullableString(stateRow, "last_reviewed_at") ? Date.parse(String(nullableString(stateRow, "last_reviewed_at"))) : null,
        learningStepIndex: (stateRow as Record<string, unknown>).learning_step == null ? null : numberValue(stateRow, "learning_step"),
        scheduledIntervalDays: numberValue(stateRow, "scheduled_interval_days"),
        reps: numberValue(stateRow, "reps"),
        lapses: numberValue(stateRow, "lapses"),
      }
      priorRevision = numberValue(stateRow, "revision")
    }
    const transition = reviewLearningCard({ nowMs: input.reviewedAtMs, rating, state: priorState })
    const resultingState = persistedState(transition.state)
    const resultingJson = JSON.stringify(resultingState)
    const eventId = makeId("lre")
    const sequenceRow = await executeFirst(tx, {
      sql: `SELECT COALESCE(MAX(item_event_sequence), 0) + 1 AS next_sequence FROM learning_review_events WHERE user_id = ?1 AND review_item_id = ?2`,
      args: [input.userId, input.itemId],
    })
    const sequence = numberValue(sequenceRow, "next_sequence")
    const priorHash = await stateHash(priorState)
    const sessionChanged = await tx.execute({
      sql: `
        INSERT INTO learning_review_events (
          learning_review_event_id, user_id, review_item_id, learning_deck_id,
          learning_deck_version_id, learning_session_id, idempotency_key,
          item_event_sequence, rating, reviewed_at, algorithm, parameters_version,
          content_version, prior_state_hash, resulting_state_json, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13, ?14, ?10)
      `,
      args: [eventId, input.userId, input.itemId, access.learning_deck_id, access.learning_deck_version_id, input.sessionId, input.idempotencyKey, sequence, rating, reviewedAt, LEARNING_REVIEW_ALGORITHM, LEARNING_REVIEW_PARAMETERS_VERSION, priorHash, resultingJson],
    })
    const newRevision = priorRevision + 1
    const stateArgs = [input.userId, input.itemId, LEARNING_REVIEW_ALGORITHM, LEARNING_REVIEW_PARAMETERS_VERSION, transition.state.phase, transition.state.stability, transition.state.difficulty, transition.state.learningStepIndex, transition.state.scheduledIntervalDays, new Date(transition.state.dueAtMs).toISOString(), reviewedAt, transition.state.reps, transition.state.lapses, newRevision, eventId, reviewedAt]
    if (stateRow) {
      const updated = await tx.execute({
        sql: `
          UPDATE learning_review_state
          SET algorithm = ?3, parameters_version = ?4, phase = ?5, stability = ?6,
              difficulty = ?7, learning_step = ?8, scheduled_interval_days = ?9,
              due_at = ?10, last_reviewed_at = ?11, reps = ?12, lapses = ?13,
              revision = ?14, last_review_event_id = ?15, updated_at = ?16
          WHERE user_id = ?1 AND review_item_id = ?2 AND revision = ?17
        `,
        args: [...stateArgs, priorRevision],
      })
      if ((updated.rowsAffected ?? 0) !== 1) throw conflictError("Learning review changed; retry with a new session revision")
    } else {
      await tx.execute({
        sql: `
          INSERT INTO learning_review_state (
            user_id, review_item_id, algorithm, parameters_version, phase,
            stability, difficulty, learning_step, scheduled_interval_days,
            due_at, last_reviewed_at, reps, lapses, revision,
            last_review_event_id, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
        `,
        args: stateArgs,
      })
    }
    const nextRow = await executeFirst(tx, {
      sql: `
        SELECT review_item_id FROM learning_session_items
        WHERE learning_session_id = ?1 AND status = 'pending'
        ORDER BY ordinal ASC LIMIT 1
      `,
      args: [input.sessionId],
    })
    const nextItemId = nextRow ? stringValue(nextRow, "review_item_id") : null
    await tx.execute({
      sql: `
        UPDATE learning_session_items
        SET status = 'reviewed', reviewed_event_id = ?1
        WHERE learning_session_id = ?2 AND review_item_id = ?3 AND status = 'revealed'
      `,
      args: [eventId, input.sessionId, input.itemId],
    })
    if (nextItemId) {
      await tx.execute({
        sql: `UPDATE learning_session_items SET status = 'current' WHERE learning_session_id = ?1 AND review_item_id = ?2 AND status = 'pending'`,
        args: [input.sessionId, nextItemId],
      })
    }
    await tx.execute({
      sql: `
        UPDATE learning_sessions
        SET session_revision = session_revision + 1,
            current_item_id = ?1,
            reviewed_count = reviewed_count + 1,
            status = CASE WHEN ?1 IS NULL THEN 'completed' ELSE 'active' END,
            completed_at = CASE WHEN ?1 IS NULL THEN ?2 ELSE NULL END
        WHERE learning_session_id = ?3 AND user_id = ?4 AND status = 'active' AND session_revision = ?5
      `,
      args: [nextItemId, nextItemId ? null : reviewedAt, input.sessionId, input.userId, input.expectedSessionRevision],
    })
    if ((sessionChanged.rowsAffected ?? 0) !== 1) throw conflictError("Learning session changed; reload it")
    return { eventId, replayed: false, stateJson: resultingJson, rating }
  })
  const updatedSession = await loadSession(input.client, input.sessionId, input.userId)
  const nextItem = updatedSession.current_item_id ? await loadSessionItem(input.client, input.sessionId, updatedSession.current_item_id) : null
  return { ...view(updatedSession, nextItem), replayed: result.replayed, rating: result.rating, next_item: view(updatedSession, nextItem).current_item }
}
