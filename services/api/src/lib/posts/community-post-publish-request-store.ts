import type { DbExecutor } from "../db-helpers"
import { makeId } from "../helpers"
import type { CreatePostRequest } from "../../types"

export type PostPublishRequestRow = {
  post_publish_request_id: string
  community_id: string
  post_id: string
  publish_mode: "sync" | "async"
  request_body_hash: string
  listing_draft_json: string | null
  publish_options_json: string | null
  status: "pending" | "running" | "succeeded" | "failed"
  failure_code: string | null
  failure_message: string | null
  created_at: string
  updated_at: string
}

function stringOrNull(row: unknown, key: string): string | null {
  const value = (row as Record<string, unknown>)[key]
  return typeof value === "string" ? value : null
}

function requiredString(row: unknown, key: string): string {
  const value = stringOrNull(row, key)
  if (!value) {
    throw new Error(`Missing required column ${key}`)
  }
  return value
}

export async function getPostPublishRequest(input: {
  client: DbExecutor
  communityId: string
  postId: string
}): Promise<PostPublishRequestRow | null> {
  const result = await input.client.execute({
    sql: `
      SELECT post_publish_request_id, community_id, post_id, publish_mode, request_body_hash,
             listing_draft_json, publish_options_json, status, failure_code, failure_message,
             created_at, updated_at
      FROM post_publish_requests
      WHERE community_id = ?1
        AND post_id = ?2
      LIMIT 1
    `,
    args: [input.communityId, input.postId],
  })
  const row = result.rows[0]
  if (!row) {
    return null
  }
  return {
    post_publish_request_id: requiredString(row, "post_publish_request_id"),
    community_id: requiredString(row, "community_id"),
    post_id: requiredString(row, "post_id"),
    publish_mode: requiredString(row, "publish_mode") as PostPublishRequestRow["publish_mode"],
    request_body_hash: requiredString(row, "request_body_hash"),
    listing_draft_json: stringOrNull(row, "listing_draft_json"),
    publish_options_json: stringOrNull(row, "publish_options_json"),
    status: requiredString(row, "status") as PostPublishRequestRow["status"],
    failure_code: stringOrNull(row, "failure_code"),
    failure_message: stringOrNull(row, "failure_message"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export async function insertPostPublishRequest(input: {
  client: DbExecutor
  communityId: string
  postId: string
  publishMode: "sync" | "async"
  requestBodyHash: string
  listingDraft: CreatePostRequest["listing_draft"] | null | undefined
  publishOptions: Record<string, unknown> | null
  status: "pending" | "running" | "succeeded" | "failed"
  createdAt: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      INSERT INTO post_publish_requests (
        post_publish_request_id, community_id, post_id, publish_mode, request_body_hash,
        listing_draft_json, publish_options_json, status, failure_code, failure_message,
        created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        ?6, ?7, ?8, NULL, NULL,
        ?9, ?9
      )
      ON CONFLICT(community_id, post_id) DO NOTHING
    `,
    args: [
      makeId("ppr"),
      input.communityId,
      input.postId,
      input.publishMode,
      input.requestBodyHash,
      input.listingDraft ? JSON.stringify(input.listingDraft) : null,
      input.publishOptions ? JSON.stringify(input.publishOptions) : null,
      input.status,
      input.createdAt,
    ],
  })
}

export async function markPostPublishRequestStatus(input: {
  client: DbExecutor
  communityId: string
  postId: string
  status: "pending" | "running" | "succeeded" | "failed"
  failureCode?: string | null
  failureMessage?: string | null
  updatedAt: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE post_publish_requests
      SET status = ?3,
          failure_code = ?4,
          failure_message = ?5,
          updated_at = ?6
      WHERE community_id = ?1
        AND post_id = ?2
    `,
    args: [
      input.communityId,
      input.postId,
      input.status,
      input.failureCode ?? null,
      input.failureMessage ?? null,
      input.updatedAt,
    ],
  })
}
