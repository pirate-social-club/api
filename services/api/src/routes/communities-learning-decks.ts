import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import { badRequestError } from "../lib/errors"
import { openCommunityWriteClient } from "../lib/communities/community-read-access"
import { requireMemberAccess } from "../lib/communities/community-content-access"
import {
  commitLearningDeckCsv,
  createLearningDeckDraft,
  getLearningDeckDraft,
  previewLearningDeckCsv,
  retireLearningDeckCard,
  upsertLearningDeckCard,
  validateLearningDeckDraft,
} from "../lib/learning/deck-authoring-service"
import {
  getResolvedCommunityRouteContext,
  requireJsonBody,
} from "./communities-route-helpers"
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
    const { csv } = await requireJsonBody<{ csv?: unknown }>(c, "Invalid learning deck CSV payload")
    if (typeof csv !== "string") throw badRequestError("csv is required")
    return c.json(previewLearningDeckCsv(csv), 200)
  })

  communities.post("/:communityId/learning-decks/:deckId/imports/commit", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<{
      csv?: unknown
      prompt_column?: unknown
      answer_column?: unknown
      tags_column?: unknown
    }>(c, "Invalid learning deck CSV payload")
    if (typeof body.csv !== "string") throw badRequestError("csv is required")
    const promptColumn = Number(body.prompt_column)
    const answerColumn = Number(body.answer_column)
    const tagsColumn = body.tags_column == null ? null : Number(body.tags_column)
    const db = await openCommunityWriteClient(c.env, communityRepository, communityId)
    try {
      await requireMemberAccess(db.client, communityId, actor.userId)
      const deck = await commitLearningDeckCsv({
        client: db.client,
        communityId,
        deckId: c.req.param("deckId"),
        userId: actor.userId,
        csv: body.csv,
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
