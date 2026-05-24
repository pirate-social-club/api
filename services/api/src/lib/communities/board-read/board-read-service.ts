import { executeFirst } from "../../db-helpers"
import { numberOrNull, rowValue, stringOrNull } from "../../sql-row"
import type { Client } from "../../sql-client"

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50
const DEFAULT_EXCERPT_CHARS = 280
const MAX_CANDIDATE_ROWS = 250
const RECENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

export type BoardReadPostVisibility = "public" | "members_only"

export type BoardReadPost = {
  authorUserId: string | null
  bodyExcerpt: string
  captionExcerpt: string
  commentCount: number
  communityId: string
  createdAt: string
  identityMode: "public" | "anonymous"
  postId: string
  postType: string
  title: string
  updatedAt: string
  visibility: BoardReadPostVisibility | null
}

export type BoardReadPostSearchResult = BoardReadPost & {
  keywordScore: number
  recencyScore: number
  score: number
}

export type BoardReadComment = {
  authorUserId: string | null
  bodyExcerpt: string
  commentId: string
  communityId: string
  createdAt: string
  depth: number
  identityMode: "public" | "anonymous"
  parentCommentId: string | null
  score: number
  threadRootPostId: string
  threadTitle: string
  updatedAt: string
}

export type BoardReadThread = {
  comments: BoardReadComment[]
  post: BoardReadPost
}

export type PublishedPostSearchOptions = {
  excerptChars?: number
  limit?: number
  query?: string | null
  since?: string | null
  visibility?: BoardReadPostVisibility | null
}

export type UserActivityOptions = {
  excerptChars?: number
  limit?: number
}

export type ThreadReadOptions = {
  commentLimit?: number
  excerptChars?: number
  visibility?: BoardReadPostVisibility | null
}

function clampLimit(value: number | null | undefined, fallback = DEFAULT_LIMIT, max = MAX_LIMIT): number {
  if (!Number.isFinite(value ?? Number.NaN)) return fallback
  return Math.min(max, Math.max(1, Math.trunc(value as number)))
}

function clampExcerptChars(value: number | null | undefined): number {
  if (!Number.isFinite(value ?? Number.NaN)) return DEFAULT_EXCERPT_CHARS
  return Math.min(2_000, Math.max(40, Math.trunc(value as number)))
}

export function excerptText(value: unknown, maxChars = DEFAULT_EXCERPT_CHARS): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim()
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

function requiredText(row: unknown, key: string): string {
  return stringOrNull(rowValue(row, key)) ?? ""
}

function optionalText(row: unknown, key: string): string | null {
  const value = stringOrNull(rowValue(row, key))
  return value?.trim() ? value : null
}

function numeric(row: unknown, key: string): number {
  return numberOrNull(rowValue(row, key)) ?? 0
}

function identityMode(row: unknown): "public" | "anonymous" {
  return requiredText(row, "identity_mode") === "anonymous" ? "anonymous" : "public"
}

function visibility(row: unknown): BoardReadPostVisibility | null {
  const value = optionalText(row, "visibility")
  return value === "public" || value === "members_only" ? value : null
}

function normalizeSearchTokens(query: string | null | undefined): string[] {
  const words = String(query ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_ -]+/gu, " ")
    .split(/\s+/u)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2)
  return [...new Set(words)].slice(0, 8)
}

function likePattern(token: string): string {
  return `%${token.replace(/[\\%_]/gu, (match) => `\\${match}`)}%`
}

function buildKeywordFilter(tokens: readonly string[], nextArgIndex: number): { sql: string; args: string[] } {
  if (tokens.length === 0) {
    return { sql: "", args: [] }
  }
  const clauses: string[] = []
  const args: string[] = []
  for (const token of tokens) {
    const pattern = likePattern(token)
    const titleIndex = nextArgIndex + args.length
    args.push(pattern)
    const bodyIndex = nextArgIndex + args.length
    args.push(pattern)
    const captionIndex = nextArgIndex + args.length
    args.push(pattern)
    clauses.push(`(
      lower(coalesce(title, '')) LIKE ?${titleIndex} ESCAPE '\\'
      OR lower(coalesce(body, '')) LIKE ?${bodyIndex} ESCAPE '\\'
      OR lower(coalesce(caption, '')) LIKE ?${captionIndex} ESCAPE '\\'
    )`)
  }
  return {
    sql: `AND (${clauses.join(" OR ")})`,
    args,
  }
}

function buildVisibilityFilter(
  visibilityValue: BoardReadPostVisibility | null | undefined,
  nextArgIndex: number,
): { sql: string; args: string[] } {
  if (!visibilityValue) {
    return { sql: "", args: [] }
  }
  return {
    sql: `AND visibility = ?${nextArgIndex}`,
    args: [visibilityValue],
  }
}

function keywordScoreForPost(row: unknown, tokens: readonly string[]): number {
  if (tokens.length === 0) return 0
  const title = requiredText(row, "title").toLowerCase()
  const body = requiredText(row, "body").toLowerCase()
  const caption = requiredText(row, "caption").toLowerCase()
  let points = 0
  for (const token of tokens) {
    if (title.includes(token)) points += 3
    if (body.includes(token)) points += 1
    if (caption.includes(token)) points += 1
  }
  return Math.min(1, points / (tokens.length * 5))
}

function recencyScore(createdAt: string, nowMs = Date.now()): number {
  const createdMs = Date.parse(createdAt)
  if (!Number.isFinite(createdMs)) return 0
  const ageMs = Math.max(0, nowMs - createdMs)
  if (ageMs >= RECENCY_WINDOW_MS) return 0
  return 1 - ageMs / RECENCY_WINDOW_MS
}

function commentScore(commentCount: number): number {
  return Math.min(1, Math.max(0, commentCount) / 20)
}

function postFromRow(row: unknown, excerptChars: number): BoardReadPost {
  return {
    authorUserId: optionalText(row, "author_user_id"),
    bodyExcerpt: excerptText(rowValue(row, "body"), excerptChars),
    captionExcerpt: excerptText(rowValue(row, "caption"), excerptChars),
    commentCount: numeric(row, "comment_count"),
    communityId: requiredText(row, "community_id"),
    createdAt: requiredText(row, "created_at"),
    identityMode: identityMode(row),
    postId: requiredText(row, "post_id"),
    postType: requiredText(row, "post_type") || "text",
    title: requiredText(row, "title").trim(),
    updatedAt: requiredText(row, "updated_at"),
    visibility: visibility(row),
  }
}

function commentFromRow(row: unknown, excerptChars: number): BoardReadComment {
  return {
    authorUserId: optionalText(row, "author_user_id"),
    bodyExcerpt: excerptText(rowValue(row, "body"), excerptChars),
    commentId: requiredText(row, "comment_id"),
    communityId: requiredText(row, "community_id"),
    createdAt: requiredText(row, "created_at"),
    depth: numeric(row, "depth"),
    identityMode: identityMode(row),
    parentCommentId: optionalText(row, "parent_comment_id"),
    score: numeric(row, "score"),
    threadRootPostId: requiredText(row, "thread_root_post_id"),
    threadTitle: requiredText(row, "thread_title").trim(),
    updatedAt: requiredText(row, "updated_at"),
  }
}

export async function searchPublishedPosts(
  client: Client,
  communityId: string,
  options: PublishedPostSearchOptions = {},
): Promise<BoardReadPostSearchResult[]> {
  const limit = clampLimit(options.limit)
  const candidateLimit = Math.min(MAX_CANDIDATE_ROWS, Math.max(limit * 8, 50))
  const excerptChars = clampExcerptChars(options.excerptChars)
  const tokens = normalizeSearchTokens(options.query)
  const since = options.since?.trim() || null
  const visibilityFilter = buildVisibilityFilter(options.visibility, 3)
  const keywordFilter = buildKeywordFilter(tokens, 3 + visibilityFilter.args.length)
  const args = [
    communityId,
    since,
    ...visibilityFilter.args,
    ...keywordFilter.args,
    candidateLimit,
  ]

  const result = await client.execute({
    sql: `
      SELECT post_id, community_id, author_user_id, identity_mode, post_type, title, body, caption,
             status, created_at, updated_at, visibility,
             (
               SELECT COUNT(*)
               FROM comments
               WHERE comments.thread_root_post_id = posts.post_id
                 AND comments.status = 'published'
             ) AS comment_count
      FROM posts
      WHERE community_id = ?1
        AND status = 'published'
        AND (?2 IS NULL OR created_at >= ?2)
        ${visibilityFilter.sql}
        ${keywordFilter.sql}
      ORDER BY created_at DESC, post_id DESC
      LIMIT ?${args.length}
    `,
    args,
  })

  const nowMs = Date.now()
  return result.rows
    .map((row) => {
      const post = postFromRow(row, excerptChars)
      const keywordScore = keywordScoreForPost(row, tokens)
      const recency = recencyScore(post.createdAt, nowMs)
      const score = keywordScore * 0.3 + recency * 0.4 + commentScore(post.commentCount) * 0.3
      return {
        ...post,
        keywordScore,
        recencyScore: recency,
        score,
      }
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      if (right.keywordScore !== left.keywordScore) return right.keywordScore - left.keywordScore
      if (right.commentCount !== left.commentCount) return right.commentCount - left.commentCount
      return right.createdAt.localeCompare(left.createdAt) || right.postId.localeCompare(left.postId)
    })
    .slice(0, limit)
}

export async function listUserPostsInCommunity(
  client: Client,
  communityId: string,
  userId: string,
  options: UserActivityOptions = {},
): Promise<BoardReadPost[]> {
  const limit = clampLimit(options.limit)
  const excerptChars = clampExcerptChars(options.excerptChars)
  const result = await client.execute({
    sql: `
      SELECT post_id, community_id, author_user_id, identity_mode, post_type, title, body, caption,
             status, created_at, updated_at, visibility,
             (
               SELECT COUNT(*)
               FROM comments
               WHERE comments.thread_root_post_id = posts.post_id
                 AND comments.status = 'published'
             ) AS comment_count
      FROM posts
      WHERE community_id = ?1
        AND author_user_id = ?2
        AND status = 'published'
      ORDER BY created_at DESC, post_id DESC
      LIMIT ?3
    `,
    args: [communityId, userId, limit],
  })
  return result.rows.map((row) => postFromRow(row, excerptChars))
}

export async function listUserCommentsInCommunity(
  client: Client,
  communityId: string,
  userId: string,
  options: UserActivityOptions = {},
): Promise<BoardReadComment[]> {
  const limit = clampLimit(options.limit)
  const excerptChars = clampExcerptChars(options.excerptChars)
  const result = await client.execute({
    sql: `
      SELECT comments.comment_id, comments.community_id, comments.thread_root_post_id,
             comments.parent_comment_id, comments.author_user_id, comments.identity_mode,
             comments.body, comments.score, comments.depth, comments.created_at, comments.updated_at,
             posts.title AS thread_title
      FROM comments
      JOIN posts
        ON posts.post_id = comments.thread_root_post_id
       AND posts.community_id = comments.community_id
      WHERE comments.community_id = ?1
        AND comments.author_user_id = ?2
        AND comments.status = 'published'
        AND posts.status = 'published'
      ORDER BY comments.created_at DESC, comments.comment_id DESC
      LIMIT ?3
    `,
    args: [communityId, userId, limit],
  })
  return result.rows.map((row) => commentFromRow(row, excerptChars))
}

export async function getThreadWithComments(
  client: Client,
  postId: string,
  options: ThreadReadOptions = {},
): Promise<BoardReadThread | null> {
  const excerptChars = clampExcerptChars(options.excerptChars)
  const commentLimit = clampLimit(options.commentLimit, 10, 100)
  const visibilityFilter = buildVisibilityFilter(options.visibility, 2)
  const postRow = await executeFirst(client, {
    sql: `
      SELECT post_id, community_id, author_user_id, identity_mode, post_type, title, body, caption,
             status, created_at, updated_at, visibility,
             (
               SELECT COUNT(*)
               FROM comments
               WHERE comments.thread_root_post_id = posts.post_id
                 AND comments.status = 'published'
             ) AS comment_count
      FROM posts
      WHERE post_id = ?1
        AND status = 'published'
        ${visibilityFilter.sql}
      LIMIT 1
    `,
    args: [postId, ...visibilityFilter.args],
  })
  if (!postRow) return null

  const post = postFromRow(postRow, excerptChars)
  const comments = await client.execute({
    sql: `
      SELECT comments.comment_id, comments.community_id, comments.thread_root_post_id,
             comments.parent_comment_id, comments.author_user_id, comments.identity_mode,
             comments.body, comments.score, comments.depth, comments.created_at, comments.updated_at,
             ?1 AS thread_title
      FROM comments
      WHERE comments.thread_root_post_id = ?2
        AND comments.status = 'published'
      ORDER BY comments.score DESC, comments.created_at DESC, comments.comment_id DESC
      LIMIT ?3
    `,
    args: [post.title, post.postId, commentLimit],
  })

  return {
    post,
    comments: comments.rows.map((row) => commentFromRow(row, excerptChars)),
  }
}
