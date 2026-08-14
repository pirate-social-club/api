import type { Env } from "../../env"
import { badRequestError, conflictError, notFoundError } from "../errors"
import { sha256Hex } from "../crypto"
import { learningDecksEnabled, makeId, nowIso } from "../helpers"
import { executeFirst, type DbExecutor } from "../db-helpers"
import type { Client } from "../sql-client"
import { withTransaction } from "../transactions"
import {
  canonicalLearningDeckPackage,
  parseLearningDeckCsv,
  validateLearningDeck,
  type DeckCsvParseResult,
  type LearningCardInput,
  type LearningCardType,
} from "./deck-package"
import { openCommunityWriteClient } from "../communities/community-read-access"
import {
  requireActiveCommunity,
  requireMemberAccess,
} from "../communities/community-content-access"
import type { CommunityReadRepository } from "../communities/db-community-repository"
import type { CommunityDatabaseBindingRepository } from "../communities/community-repository-types"

type DeckCommunityRepository = CommunityReadRepository & CommunityDatabaseBindingRepository

export type LearningDeckRow = {
  learning_deck_id: string
  community_id: string
  creator_user_id: string
  source_post_id: string | null
  asset_id: string | null
  title: string
  description: string | null
  status: "draft" | "published" | "archived"
  active_draft_version: number
  published_version: number | null
  created_at: string
  updated_at: string
}

export type LearningDeckVersionRow = {
  learning_deck_version_id: string
  learning_deck_id: string
  version: number
  schema_version: number
  status: "draft" | "validating" | "ready" | "published" | "failed"
  content_hash: string | null
  card_count: number
  canonical_blob_ref: string | null
  validation_error_json: string | null
  created_at: string
  updated_at: string
  published_at: string | null
}

export type LearningCardRow = LearningCardInput & {
  retiredAt: string | null
  contentHash: string
  ordinal: number
}

export type LearningDeckDraft = {
  deck: LearningDeckRow
  version: LearningDeckVersionRow
  cards: LearningCardRow[]
}

function row<T>(value: unknown, key: string): T {
  const result = (value as Record<string, unknown> | undefined)?.[key]
  if (result == null) throw new Error(`Missing required learning deck column ${key}`)
  return result as T
}

function optionalRow<T>(value: unknown, key: string): T | null {
  const result = (value as Record<string, unknown> | undefined)?.[key]
  return result == null ? null : result as T
}

function parseTextDocument(value: string, field: string): string {
  try {
    const parsed = JSON.parse(value) as { type?: unknown; text?: unknown }
    if (parsed?.type === "text" && typeof parsed.text === "string") return parsed.text
  } catch {
    // The row is malformed and should not be served as answer-bearing content.
  }
  throw conflictError(`Learning card ${field} document is invalid`)
}

function deckFromRow(value: unknown): LearningDeckRow {
  return {
    learning_deck_id: row<string>(value, "learning_deck_id"),
    community_id: row<string>(value, "community_id"),
    creator_user_id: row<string>(value, "creator_user_id"),
    source_post_id: optionalRow<string>(value, "source_post_id"),
    asset_id: optionalRow<string>(value, "asset_id"),
    title: row<string>(value, "title"),
    description: optionalRow<string>(value, "description"),
    status: row<LearningDeckRow["status"]>(value, "status"),
    active_draft_version: Number(row<number>(value, "active_draft_version")),
    published_version: optionalRow<number>(value, "published_version"),
    created_at: row<string>(value, "created_at"),
    updated_at: row<string>(value, "updated_at"),
  }
}

function versionFromRow(value: unknown): LearningDeckVersionRow {
  return {
    learning_deck_version_id: row<string>(value, "learning_deck_version_id"),
    learning_deck_id: row<string>(value, "learning_deck_id"),
    version: Number(row<number>(value, "version")),
    schema_version: Number(row<number>(value, "schema_version")),
    status: row<LearningDeckVersionRow["status"]>(value, "status"),
    content_hash: optionalRow<string>(value, "content_hash"),
    card_count: Number(row<number>(value, "card_count")),
    canonical_blob_ref: optionalRow<string>(value, "canonical_blob_ref"),
    validation_error_json: optionalRow<string>(value, "validation_error_json"),
    created_at: row<string>(value, "created_at"),
    updated_at: row<string>(value, "updated_at"),
    published_at: optionalRow<string>(value, "published_at"),
  }
}

const DECK_COLUMNS = `learning_deck_id, community_id, creator_user_id, source_post_id,
  asset_id, title, description, status, active_draft_version, published_version,
  created_at, updated_at`

const VERSION_COLUMNS = `learning_deck_version_id, learning_deck_id, version,
  schema_version, status, content_hash, card_count, canonical_blob_ref,
  validation_error_json, created_at, updated_at, published_at`

async function loadDeck(input: { client: DbExecutor; communityId: string; deckId: string }): Promise<LearningDeckRow | null> {
  const found = await executeFirst(input.client, {
    sql: `SELECT ${DECK_COLUMNS} FROM learning_decks WHERE community_id = ?1 AND learning_deck_id = ?2 LIMIT 1`,
    args: [input.communityId, input.deckId],
  })
  return found ? deckFromRow(found) : null
}

async function loadVersion(input: { client: DbExecutor; deckId: string; version?: number }): Promise<LearningDeckVersionRow | null> {
  const found = await executeFirst(input.client, {
    sql: `
      SELECT ${VERSION_COLUMNS}
      FROM learning_deck_versions
      WHERE learning_deck_id = ?1
        AND (?2 IS NULL OR version = ?2)
      ORDER BY version DESC
      LIMIT 1
    `,
    args: [input.deckId, input.version ?? null],
  })
  return found ? versionFromRow(found) : null
}

async function loadCards(input: { client: DbExecutor; versionId: string }): Promise<LearningCardRow[]> {
  const result = await input.client.execute({
    sql: `
      SELECT cards.learning_card_id, cards.retired_at, card_versions.ordinal,
             card_versions.card_type, card_versions.prompt_json,
             card_versions.answer_json, card_versions.tags_json,
             card_versions.content_hash
      FROM learning_card_versions card_versions
      JOIN learning_cards cards ON cards.learning_card_id = card_versions.learning_card_id
      WHERE card_versions.learning_deck_version_id = ?1
      ORDER BY card_versions.ordinal ASC, card_versions.learning_card_id ASC
    `,
    args: [input.versionId],
  })
  return result.rows.map((value) => {
    const tags = JSON.parse(row<string>(value, "tags_json")) as unknown
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
      throw conflictError("Learning card tags document is invalid")
    }
    return {
      cardId: row<string>(value, "learning_card_id"),
      cardType: row<LearningCardType>(value, "card_type"),
      prompt: parseTextDocument(row<string>(value, "prompt_json"), "prompt"),
      answer: parseTextDocument(row<string>(value, "answer_json"), "answer"),
      tags: tags as string[],
      retiredAt: optionalRow<string>(value, "retired_at"),
      contentHash: row<string>(value, "content_hash"),
      ordinal: Number(row<number>(value, "ordinal")),
    }
  })
}

async function assertOwnedDraft(input: {
  client: DbExecutor
  communityId: string
  deckId: string
  userId: string
}): Promise<{ deck: LearningDeckRow; version: LearningDeckVersionRow }> {
  const deck = await loadDeck(input)
  if (!deck || deck.creator_user_id !== input.userId) throw notFoundError("Learning deck not found")
  if (deck.status !== "draft") throw conflictError("Published learning decks are immutable")
  const version = await loadVersion({ client: input.client, deckId: input.deckId, version: deck.active_draft_version })
  if (!version || version.status === "published") throw conflictError("Learning deck draft version is unavailable")
  return { deck, version }
}

function cardContentHash(input: Pick<LearningCardInput, "cardId" | "cardType" | "prompt" | "answer" | "tags">): Promise<string> {
  return sha256Hex(JSON.stringify({
    card_id: input.cardId,
    card_type: input.cardType,
    prompt: input.prompt,
    answer: input.answer,
    tags: [...(input.tags ?? [])].sort(),
  })).then((hash) => `0x${hash}`)
}

export async function getLearningDeckDraft(input: {
  client: DbExecutor
  communityId: string
  deckId: string
  userId: string
}): Promise<LearningDeckDraft> {
  const { deck, version } = await assertOwnedDraft(input)
  return { deck, version, cards: await loadCards({ client: input.client, versionId: version.learning_deck_version_id }) }
}

export async function createLearningDeckDraft(input: {
  env: Env
  communityRepository: DeckCommunityRepository
  communityId: string
  userId: string
  title: string
  description?: string | null
}): Promise<LearningDeckDraft> {
  if (!learningDecksEnabled(input.env)) throw notFoundError("Learning decks are not enabled")
  await requireActiveCommunity(input.communityRepository, input.communityId)
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, input.userId)
    const issues = validateLearningDeck({ title: input.title, description: input.description, cards: [{ cardId: "lcd_placeholder", cardType: "basic", prompt: "placeholder", answer: "placeholder" }] })
      .filter((issue) => issue.code !== "cards_required" && issue.cardIndex == null)
    if (issues.length) throw badRequestError(issues[0]?.message ?? "Invalid learning deck")
    const now = nowIso()
    const deckId = makeId("ldk")
    const versionId = makeId("ldv")
    await withTransaction(db.client, "write", async (tx) => {
      await tx.execute({
        sql: `
          INSERT INTO learning_decks (
            learning_deck_id, community_id, creator_user_id, title, description,
            status, active_draft_version, published_version, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, 'draft', 1, NULL, ?6, ?6)
        `,
        args: [deckId, input.communityId, input.userId, input.title.normalize("NFC").trim(), input.description?.normalize("NFC") ?? null, now],
      })
      await tx.execute({
        sql: `
          INSERT INTO learning_deck_versions (
            learning_deck_version_id, learning_deck_id, version, schema_version,
            status, content_hash, card_count, canonical_blob_ref,
            validation_error_json, created_at, updated_at, published_at
          ) VALUES (?1, ?2, 1, 1, 'draft', NULL, 0, NULL, NULL, ?3, ?3, NULL)
        `,
        args: [versionId, deckId, now],
      })
    })
    return await getLearningDeckDraft({ client: db.client, communityId: input.communityId, deckId, userId: input.userId })
  } finally {
    await db.close()
  }
}

export async function upsertLearningDeckCard(input: {
  client: DbExecutor
  communityId: string
  deckId: string
  userId: string
  cardId?: string | null
  cardType: LearningCardType
  prompt: string
  answer: string
  tags?: string[]
  ordinal?: number | null
}): Promise<LearningDeckDraft> {
  const draft = await assertOwnedDraft(input)
  const cardId = input.cardId?.trim() || makeId("lcd")
  const candidate: LearningCardInput = {
    cardId,
    cardType: input.cardType,
    prompt: input.prompt,
    answer: input.answer,
    tags: input.tags,
  }
  const issues = validateLearningDeck({ title: draft.deck.title, description: draft.deck.description, cards: [candidate] })
    .filter((issue) => issue.code !== "cards_required")
  if (issues.length) throw badRequestError(issues[0]?.message ?? "Invalid learning card")
  const contentHash = await cardContentHash(candidate)
  const now = nowIso()
  const nextOrdinal = input.ordinal == null
    ? (await loadCards({ client: input.client, versionId: draft.version.learning_deck_version_id })).length
    : Math.max(0, Math.trunc(input.ordinal))
  const promptJson = JSON.stringify({ type: "text", text: candidate.prompt.normalize("NFC") })
  const answerJson = JSON.stringify({ type: "text", text: candidate.answer.normalize("NFC") })
  const tagsJson = JSON.stringify([...(candidate.tags ?? [])].map((tag) => tag.normalize("NFC")).sort())
  await withTransaction(input.client as Client, "write", async (tx) => {
    const existing = await executeFirst(tx, {
      sql: `SELECT learning_card_id FROM learning_cards WHERE learning_deck_id = ?1 AND learning_card_id = ?2 LIMIT 1`,
      args: [input.deckId, cardId],
    })
    if (!existing) {
      await tx.execute({
        sql: `INSERT INTO learning_cards (learning_card_id, learning_deck_id, created_at, retired_at) VALUES (?1, ?2, ?3, NULL)`,
        args: [cardId, input.deckId, now],
      })
      await tx.execute({
        sql: `
          INSERT INTO learning_review_items (
            review_item_id, item_kind, subject_ref, content_version, status, created_at, updated_at
          ) VALUES (?1, 'deck_card', ?2, 1, 'active', ?3, ?3)
        `,
        args: [makeId("lri"), cardId, now],
      })
    }
    await tx.execute({
      sql: `
        INSERT INTO learning_card_versions (
          learning_deck_version_id, learning_card_id, ordinal, card_type,
          prompt_json, answer_json, tags_json, content_hash, created_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
        ON CONFLICT(learning_deck_version_id, learning_card_id) DO UPDATE SET
          ordinal = excluded.ordinal, card_type = excluded.card_type,
          prompt_json = excluded.prompt_json, answer_json = excluded.answer_json,
          tags_json = excluded.tags_json, content_hash = excluded.content_hash
      `,
      args: [draft.version.learning_deck_version_id, cardId, nextOrdinal, candidate.cardType, promptJson, answerJson, tagsJson, contentHash, now],
    })
    await tx.execute({
      sql: `UPDATE learning_deck_versions SET card_count = (SELECT COUNT(*) FROM learning_card_versions WHERE learning_deck_version_id = ?1), status = 'draft', validation_error_json = NULL, updated_at = ?2 WHERE learning_deck_version_id = ?1`,
      args: [draft.version.learning_deck_version_id, now],
    })
    await tx.execute({ sql: `UPDATE learning_decks SET updated_at = ?1 WHERE learning_deck_id = ?2`, args: [now, input.deckId] })
  })
  return await getLearningDeckDraft({ client: input.client, communityId: input.communityId, deckId: input.deckId, userId: input.userId })
}

export async function retireLearningDeckCard(input: {
  client: DbExecutor
  communityId: string
  deckId: string
  userId: string
  cardId: string
}): Promise<LearningDeckDraft> {
  const draft = await assertOwnedDraft(input)
  const now = nowIso()
  await withTransaction(input.client as Client, "write", async (tx) => {
    const result = await tx.execute({
      sql: `UPDATE learning_cards SET retired_at = ?1 WHERE learning_deck_id = ?2 AND learning_card_id = ?3 AND retired_at IS NULL`,
      args: [now, input.deckId, input.cardId],
    })
    if ((result.rowsAffected ?? 0) !== 1) throw notFoundError("Learning card not found")
    await tx.execute({
      sql: `UPDATE learning_review_items SET status = 'retired', updated_at = ?1 WHERE item_kind = 'deck_card' AND subject_ref = ?2`,
      args: [now, input.cardId],
    })
    await tx.execute({ sql: `UPDATE learning_deck_versions SET updated_at = ?1 WHERE learning_deck_version_id = ?2`, args: [now, draft.version.learning_deck_version_id] })
  })
  return await getLearningDeckDraft({ client: input.client, communityId: input.communityId, deckId: input.deckId, userId: input.userId })
}

export async function validateLearningDeckDraft(input: {
  client: DbExecutor
  communityId: string
  deckId: string
  userId: string
}): Promise<{
  draft: LearningDeckDraft
  canonical: Awaited<ReturnType<typeof canonicalLearningDeckPackage>> | null
  issues: ReturnType<typeof validateLearningDeck>
}> {
  const draft = await getLearningDeckDraft(input)
  const cards = draft.cards.filter((card) => card.retiredAt == null).map(({ retiredAt: _retiredAt, contentHash: _contentHash, ordinal: _ordinal, ...card }) => card)
  const issues = validateLearningDeck({ title: draft.deck.title, description: draft.deck.description, cards })
  const now = nowIso()
  if (issues.length) {
    await input.client.execute({
      sql: `UPDATE learning_deck_versions SET status = 'failed', validation_error_json = ?1, updated_at = ?2 WHERE learning_deck_version_id = ?3`,
      args: [JSON.stringify(issues), now, draft.version.learning_deck_version_id],
    })
    return { draft: await getLearningDeckDraft(input), canonical: null, issues }
  }
  const canonical = await canonicalLearningDeckPackage({ title: draft.deck.title, description: draft.deck.description, cards })
  await input.client.execute({
    sql: `UPDATE learning_deck_versions SET status = 'ready', content_hash = ?1, card_count = ?2, validation_error_json = NULL, updated_at = ?3 WHERE learning_deck_version_id = ?4`,
    args: [canonical.contentHash, canonical.deck.cards.length, now, draft.version.learning_deck_version_id],
  })
  return { draft: await getLearningDeckDraft(input), canonical, issues: [] }
}

export function previewLearningDeckCsv(csv: string): DeckCsvParseResult {
  return parseLearningDeckCsv(csv)
}

export async function commitLearningDeckCsv(input: {
  client: DbExecutor
  communityId: string
  deckId: string
  userId: string
  csv: string
  promptColumn: number
  answerColumn: number
  tagsColumn?: number | null
}): Promise<LearningDeckDraft> {
  const parsed = parseLearningDeckCsv(input.csv)
  if (parsed.errors.length) throw badRequestError(parsed.errors[0]?.message ?? "CSV import failed")
  if (!Number.isInteger(input.promptColumn) || !Number.isInteger(input.answerColumn)) throw badRequestError("CSV column mapping is invalid")
  if (input.promptColumn < 0 || input.answerColumn < 0 || input.promptColumn >= parsed.headers.length || input.answerColumn >= parsed.headers.length) {
    throw badRequestError("CSV column mapping is out of range")
  }
  let draft = await getLearningDeckDraft(input)
  for (const values of parsed.rows) {
    const prompt = values[input.promptColumn] ?? ""
    const answer = values[input.answerColumn] ?? ""
    if (!prompt.trim() || !answer.trim()) throw badRequestError("CSV prompt and answer cells are required")
    const tags = input.tagsColumn == null ? [] : (values[input.tagsColumn] ?? "").split(/[|;]/).map((tag) => tag.trim()).filter(Boolean)
    draft = await upsertLearningDeckCard({
      client: input.client,
      communityId: input.communityId,
      deckId: input.deckId,
      userId: input.userId,
      cardType: "basic",
      prompt,
      answer,
      tags,
      ordinal: draft.cards.length,
    })
  }
  return draft
}
