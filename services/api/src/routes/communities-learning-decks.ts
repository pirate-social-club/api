import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import { badRequestError, conflictError, notFoundError } from "../lib/errors"
import { learningDecksEnabled, nowIso } from "../lib/helpers"
import { openCommunityWriteClient } from "../lib/communities/community-read-access"
import { requireMemberAccess } from "../lib/communities/community-content-access"
import {
  commitLearningDeckCsv,
  assertLearningDeckCsvImportOwned,
  createLearningDeckDraft,
  getLearningDeckDraft,
  getPublishedLearningDeckByAsset,
  type LearningDeckCsvPreview,
  retireLearningDeckCard,
  upsertLearningDeckCard,
  validateLearningDeckDraft,
} from "../lib/learning/deck-authoring-service"
import {
  enqueueCommunityJob,
  findLatestCommunityJobBySubjectAndType,
  getCommunityJobById,
  getLatestCommunityJobEvent,
  type CommunityJobRow,
} from "../lib/communities/jobs/store"
import {
  getResolvedCommunityRouteContext,
  requireJsonBody,
} from "./communities-route-helpers"
import { decodePublicAssetId } from "../lib/public-ids"
import {
  createLearningDeckSession,
  getLearningSession,
  rateLearningSessionItem,
  revealLearningSessionItem,
} from "../lib/learning/review-service"

type DraftRouteBody = {
  title?: unknown
  description?: unknown
}

type CardRouteBody = {
  card_id?: unknown
  card_type?: unknown
  prompt?: unknown
  answer?: unknown
  tags?: unknown
  ordinal?: unknown
}

type ImportJobPreviewResponse = {
  import_job_id: string
  status: CommunityJobRow["status"]
  preview: LearningDeckCsvPreview | null
  error: string | null
}

function readImportPreview(eventDetails: string | null): LearningDeckCsvPreview | null {
  if (!eventDetails) return null
  try {
    const value = JSON.parse(eventDetails) as Partial<LearningDeckCsvPreview>
    if (
      !Array.isArray(value.headers)
      || !Array.isArray(value.rows)
      || !Array.isArray(value.errors)
      || typeof value.row_count !== "number"
      || typeof value.error_count !== "number"
    ) return null
    return value as LearningDeckCsvPreview
  } catch {
    return null
  }
}

function importJobResponse(job: CommunityJobRow, preview: LearningDeckCsvPreview | null): ImportJobPreviewResponse {
  return {
    import_job_id: job.job_id,
    status: job.status,
    preview,
    error: job.error_code,
  }
}

function importJobOwner(job: CommunityJobRow): string | null {
  try {
    const payload = JSON.parse(job.payload_json ?? "{}") as { user_id?: unknown }
    return typeof payload.user_id === "string" ? payload.user_id : null
  } catch {
    return null
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw badRequestError(`${field} is required`)
  return value
}

function optionalString(value: unknown, field: string): string | null {
  if (value == null) return null
  if (typeof value !== "string") throw badRequestError(`${field} must be a string`)
  return value
}

function requiredInteger(value: unknown, field: string): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 0) throw badRequestError(`${field} must be a non-negative integer`)
  return result
}

function cardBody(body: CardRouteBody): {
  cardId: string | null
  cardType: "basic" | "cloze"
  prompt: string
  answer: string
  tags: string[]
  ordinal: number | null
} {
  const cardType = body.card_type
  if (cardType !== "basic" && cardType !== "cloze") throw badRequestError("card_type must be basic or cloze")
  if (body.tags != null && (!Array.isArray(body.tags) || body.tags.some((tag) => typeof tag !== "string"))) {
    throw badRequestError("tags must be an array of strings")
  }
  const ordinal = body.ordinal == null ? null : Number(body.ordinal)
  if (ordinal != null && (!Number.isSafeInteger(ordinal) || ordinal < 0)) throw badRequestError("ordinal must be a non-negative integer")
  return {
    cardId: body.card_id == null ? null : requiredString(body.card_id, "card_id"),
    cardType,
    prompt: requiredString(body.prompt, "prompt"),
    answer: requiredString(body.answer, "answer"),
    tags: (body.tags as string[] | undefined) ?? [],
    ordinal,
  }
}

export function registerCommunityLearningDeckRoutes(communities: Hono<AuthenticatedEnv>): void {
  const requireLearningDeckFeature = async (c: Parameters<Parameters<typeof communities.use>[1]>[0], next: () => Promise<void>) => {
    if (!learningDecksEnabled(c.env ?? {})) throw notFoundError("Learning deck not found")
    await next()
  }
  // Hono's wildcard matcher is intentionally explicit here: the collection
  // route without a trailing slash must be gated too, otherwise draft reads
  // could remain available while deck writers are disabled.
  communities.use("/:communityId/learning-decks", requireLearningDeckFeature)
  communities.use("/:communityId/learning-decks/*", requireLearningDeckFeature)
  communities.use("/:communityId/learning-study-sessions/*", requireLearningDeckFeature)

  communities.post("/:communityId/learning-decks", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<DraftRouteBody>(c, "Invalid learning deck payload")
    const deck = await createLearningDeckDraft({
      env: c.env,
      communityRepository,
      communityId,
      userId: actor.userId,
      title: requiredString(body.title, "title"),
      description: optionalString(body.description, "description"),
    })
    return c.json(deck, 201)
  })

  communities.get("/:communityId/learning-decks/by-asset/:assetId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const db = await openCommunityWriteClient(c.env, communityRepository, communityId)
    try {
      await requireMemberAccess(db.client, communityId, actor.userId)
      const published = await getPublishedLearningDeckByAsset({
        client: db.client,
        communityId,
        assetId: decodePublicAssetId(c.req.param("assetId")),
      })
      // Deck metadata is safe to use for routing, but answers must only ever
      // cross the review-session reveal boundary.
      return c.json({ ...published, cards: [] }, 200)
    } finally {
      await db.close()
    }
  })

  communities.get("/:communityId/learning-decks/imports/:importJobId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const db = await openCommunityWriteClient(c.env, communityRepository, communityId)
    try {
      await requireMemberAccess(db.client, communityId, actor.userId)
      const job = await getCommunityJobById({ client: db.client, jobId: c.req.param("importJobId") })
      if (!job || job.community_id !== communityId || job.job_type !== "learning_deck_import_parse" || importJobOwner(job) !== actor.userId) {
        throw notFoundError("Learning deck import not found")
      }
      const event = job.status === "succeeded"
        ? await getLatestCommunityJobEvent({
          client: db.client,
          jobId: job.job_id,
          checkpoint: "learning_deck_import_preview_ready",
        })
        : null
      return c.json(importJobResponse(job, readImportPreview(event?.details_json ?? null)), 200)
    } finally {
      await db.close()
    }
  })

  communities.get("/:communityId/learning-decks/:deckId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const db = await openCommunityWriteClient(c.env, communityRepository, communityId)
    try {
      await requireMemberAccess(db.client, communityId, actor.userId)
      const deck = await getLearningDeckDraft({
        client: db.client,
        communityId,
        deckId: c.req.param("deckId"),
        userId: actor.userId,
      })
      return c.json(deck, 200)
    } finally {
      await db.close()
    }
  })

  communities.post("/:communityId/learning-decks/:deckId/cards", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = cardBody(await requireJsonBody<CardRouteBody>(c, "Invalid learning card payload"))
    const db = await openCommunityWriteClient(c.env, communityRepository, communityId)
    try {
      await requireMemberAccess(db.client, communityId, actor.userId)
      const deck = await upsertLearningDeckCard({
        client: db.client,
        communityId,
        deckId: c.req.param("deckId"),
        userId: actor.userId,
        cardId: body.cardId,
        cardType: body.cardType,
        prompt: body.prompt,
        answer: body.answer,
        tags: body.tags,
        ordinal: body.ordinal,
      })
      return c.json(deck, 201)
    } finally {
      await db.close()
    }
  })

  communities.patch("/:communityId/learning-decks/:deckId/cards/:cardId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = cardBody(await requireJsonBody<CardRouteBody>(c, "Invalid learning card payload"))
    const db = await openCommunityWriteClient(c.env, communityRepository, communityId)
    try {
      await requireMemberAccess(db.client, communityId, actor.userId)
      const deck = await upsertLearningDeckCard({
        client: db.client,
        communityId,
        deckId: c.req.param("deckId"),
        userId: actor.userId,
        cardId: c.req.param("cardId"),
        cardType: body.cardType,
        prompt: body.prompt,
        answer: body.answer,
        tags: body.tags,
        ordinal: body.ordinal,
      })
      return c.json(deck, 200)
    } finally {
      await db.close()
    }
  })

  communities.delete("/:communityId/learning-decks/:deckId/cards/:cardId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const db = await openCommunityWriteClient(c.env, communityRepository, communityId)
    try {
      await requireMemberAccess(db.client, communityId, actor.userId)
      const deck = await retireLearningDeckCard({
        client: db.client,
        communityId,
        deckId: c.req.param("deckId"),
        userId: actor.userId,
        cardId: c.req.param("cardId"),
      })
      return c.json(deck, 200)
    } finally {
      await db.close()
    }
  })

  communities.post("/:communityId/learning-decks/:deckId/validate", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const db = await openCommunityWriteClient(c.env, communityRepository, communityId)
    try {
      await requireMemberAccess(db.client, communityId, actor.userId)
      const result = await validateLearningDeckDraft({
        client: db.client,
        communityId,
        deckId: c.req.param("deckId"),
        userId: actor.userId,
      })
      return c.json({
        draft: result.draft,
        issues: result.issues,
        canonical: result.canonical
          ? { schema_version: result.canonical.deck.schema_version, card_count: result.canonical.deck.cards.length, content_hash: result.canonical.contentHash, json: result.canonical.json }
          : null,
      }, 200)
    } finally {
      await db.close()
    }
  })

  communities.post("/:communityId/learning-decks/imports/preview", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const { content_blob_id: contentBlobId } = await requireJsonBody<{ content_blob_id?: unknown }>(c, "Invalid learning deck CSV payload")
    if (typeof contentBlobId !== "string") throw badRequestError("content_blob_id is required")
    await assertLearningDeckCsvImportOwned({ env: c.env, communityId, contentBlobId, userId: actor.userId })
    const db = await openCommunityWriteClient(c.env, communityRepository, communityId)
    try {
      await requireMemberAccess(db.client, communityId, actor.userId)
      let job = await findLatestCommunityJobBySubjectAndType({
        client: db.client,
        jobType: "learning_deck_import_parse",
        subjectType: "content_blob",
        subjectId: contentBlobId,
      })
      if (!job || job.status === "failed") {
        job = await enqueueCommunityJob({
          client: db.client,
          communityId,
          jobType: "learning_deck_import_parse",
          subjectType: "content_blob",
          subjectId: contentBlobId,
          payloadJson: JSON.stringify({ content_blob_id: contentBlobId, user_id: actor.userId }),
          createdAt: nowIso(),
        })
      }
      const event = job.status === "succeeded"
        ? await getLatestCommunityJobEvent({
          client: db.client,
          jobId: job.job_id,
          checkpoint: "learning_deck_import_preview_ready",
        })
        : null
      return c.json(importJobResponse(job, readImportPreview(event?.details_json ?? null)), 200)
    } finally {
      await db.close()
    }
  })

  communities.post("/:communityId/learning-decks/:deckId/imports/commit", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<{
      content_blob_id?: unknown
      import_job_id?: unknown
      prompt_column?: unknown
      answer_column?: unknown
      tags_column?: unknown
    }>(c, "Invalid learning deck CSV payload")
    if (typeof body.content_blob_id !== "string") throw badRequestError("content_blob_id is required")
    if (typeof body.import_job_id !== "string") throw badRequestError("import_job_id is required")
    const promptColumn = Number(body.prompt_column)
    const answerColumn = Number(body.answer_column)
    const tagsColumn = body.tags_column == null ? null : Number(body.tags_column)
    const db = await openCommunityWriteClient(c.env, communityRepository, communityId)
    try {
      await requireMemberAccess(db.client, communityId, actor.userId)
      const importJob = await getCommunityJobById({ client: db.client, jobId: body.import_job_id })
      if (
        !importJob
        || importJob.community_id !== communityId
        || importJob.job_type !== "learning_deck_import_parse"
        || importJob.subject_id !== body.content_blob_id
        || importJob.status !== "succeeded"
        || importJobOwner(importJob) !== actor.userId
      ) {
        throw conflictError("Learning deck CSV import is not ready to commit")
      }
      const previewEvent = await getLatestCommunityJobEvent({
        client: db.client,
        jobId: importJob.job_id,
        checkpoint: "learning_deck_import_preview_ready",
      })
      if (!previewEvent) throw conflictError("Learning deck CSV preview is unavailable")
      const deck = await commitLearningDeckCsv({
        env: c.env,
        client: db.client,
        communityId,
        deckId: c.req.param("deckId"),
        userId: actor.userId,
        contentBlobId: body.content_blob_id,
        promptColumn,
        answerColumn,
        tagsColumn,
      })
      return c.json(deck, 200)
    } finally {
      await db.close()
    }
  })

  communities.post("/:communityId/learning-decks/:deckId/study-sessions", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<{ now_ms?: unknown; limit?: unknown }>(c, "Invalid learning session payload")
    const nowMs = body.now_ms == null ? Date.now() : requiredInteger(body.now_ms, "now_ms")
    const limit = body.limit == null ? undefined : requiredInteger(body.limit, "limit")
    const db = await openCommunityWriteClient(c.env, communityRepository, communityId)
    try {
      await requireMemberAccess(db.client, communityId, actor.userId)
      const session = await createLearningDeckSession({
        client: db.client,
        communityId,
        deckId: c.req.param("deckId"),
        userId: actor.userId,
        nowMs,
        limit,
      })
      return c.json(session, 201)
    } finally {
      await db.close()
    }
  })

  communities.get("/:communityId/learning-study-sessions/:sessionId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const db = await openCommunityWriteClient(c.env, communityRepository, communityId)
    try {
      await requireMemberAccess(db.client, communityId, actor.userId)
      return c.json(await getLearningSession({
        client: db.client,
        communityId,
        sessionId: c.req.param("sessionId"),
        userId: actor.userId,
      }), 200)
    } finally {
      await db.close()
    }
  })

  communities.post("/:communityId/learning-study-sessions/:sessionId/reveal", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<{ expected_session_revision?: unknown }>(c, "Invalid learning reveal payload")
    const db = await openCommunityWriteClient(c.env, communityRepository, communityId)
    try {
      await requireMemberAccess(db.client, communityId, actor.userId)
      return c.json(await revealLearningSessionItem({
        client: db.client,
        communityId,
        sessionId: c.req.param("sessionId"),
        userId: actor.userId,
        expectedSessionRevision: requiredInteger(body.expected_session_revision, "expected_session_revision"),
      }), 200)
    } finally {
      await db.close()
    }
  })

  communities.post("/:communityId/learning-study-sessions/:sessionId/rate", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<{
      item_id?: unknown
      rating?: unknown
      idempotency_key?: unknown
      expected_session_revision?: unknown
      reviewed_at_ms?: unknown
    }>(c, "Invalid learning review payload")
    if (typeof body.item_id !== "string" || !body.item_id.trim()) throw badRequestError("item_id is required")
    if (typeof body.idempotency_key !== "string" || !body.idempotency_key.trim()) throw badRequestError("idempotency_key is required")
    if (body.rating !== "again" && body.rating !== "hard" && body.rating !== "good" && body.rating !== "easy") {
      throw badRequestError("rating must be again, hard, good, or easy")
    }
    const db = await openCommunityWriteClient(c.env, communityRepository, communityId)
    try {
      await requireMemberAccess(db.client, communityId, actor.userId)
      return c.json(await rateLearningSessionItem({
        client: db.client,
        communityId,
        sessionId: c.req.param("sessionId"),
        userId: actor.userId,
        itemId: body.item_id,
        rating: body.rating,
        idempotencyKey: body.idempotency_key,
        expectedSessionRevision: requiredInteger(body.expected_session_revision, "expected_session_revision"),
        reviewedAtMs: body.reviewed_at_ms == null ? Date.now() : requiredInteger(body.reviewed_at_ms, "reviewed_at_ms"),
      }), 200)
    } finally {
      await db.close()
    }
  })
}
