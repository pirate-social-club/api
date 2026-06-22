import { badRequestError } from "../errors"
import { packCursor, unpackCursor } from "../cursor-codec"
import { numberOrNull, rowValue } from "../sql-row"
import type { CommentListItem, CommentSort } from "./comment-types"
import { serializeComment, toCommentRow } from "./community-comment-serialization"

type CommentCursorPayload = {
  sort: CommentSort
  created_at: string
  comment_id: string
  score?: number
}

export function sortOrder(sort: CommentSort): string {
  switch (sort) {
    case "old":
      return "created_at ASC, comment_id ASC"
    case "top":
    case "best":
      return "score DESC, created_at DESC, comment_id DESC"
    case "new":
    default:
      return "created_at DESC, comment_id DESC"
  }
}

export function rowToCommentListItem(row: unknown): CommentListItem {
  return {
    comment: serializeComment(toCommentRow(row)),
    viewer_vote: numberOrNull(rowValue(row, "viewer_vote")) as -1 | 1 | null,
    viewer_can_delete: numberOrNull(rowValue(row, "viewer_can_delete")) === 1,
    resolved_locale: "en",
    translation_state: "same_language",
    machine_translated: false,
    translated_body: null,
    source_hash: "",
  }
}

export function encodeCommentCursor(cursor: CommentCursorPayload): string {
  return packCursor(cursor)
}

export function decodeCommentCursor(cursor: string, sort: CommentSort): CommentCursorPayload {
  try {
    const parsed = unpackCursor<CommentCursorPayload>(cursor)
    if (!parsed || typeof parsed !== "object") {
      throw new Error("invalid cursor")
    }
    if (parsed.sort !== sort) {
      throw badRequestError("cursor does not match the requested sort")
    }
    if (typeof parsed.created_at !== "string" || typeof parsed.comment_id !== "string") {
      throw new Error("invalid cursor")
    }
    if ((sort === "best" || sort === "top") && typeof parsed.score !== "number") {
      throw new Error("invalid cursor")
    }
    return parsed
  } catch (error) {
    if (error instanceof Error && "status" in error) {
      throw error
    }
    throw badRequestError("Invalid comment cursor")
  }
}

export function buildCursorClause(sort: CommentSort, cursor: CommentCursorPayload): { sql: string; args: unknown[] } {
  switch (sort) {
    case "old":
      return {
        sql: `
          AND (
            comments.created_at > ?4
            OR (comments.created_at = ?4 AND comments.comment_id > ?5)
          )
        `,
        args: [cursor.created_at, cursor.comment_id],
      }
    case "top":
    case "best":
      return {
        sql: `
          AND (
            comments.score < ?4
            OR (comments.score = ?4 AND comments.created_at < ?5)
            OR (comments.score = ?4 AND comments.created_at = ?5 AND comments.comment_id < ?6)
          )
        `,
        args: [cursor.score ?? 0, cursor.created_at, cursor.comment_id],
      }
    case "new":
    default:
      return {
        sql: `
          AND (
            comments.created_at < ?4
            OR (comments.created_at = ?4 AND comments.comment_id < ?5)
          )
        `,
        args: [cursor.created_at, cursor.comment_id],
      }
  }
}
