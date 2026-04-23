import {
  requiredNumber,
  requiredString,
  rowValue,
  stringOrNull,
} from "../sql-row"
import type { Job, Post } from "../../types"

export type CommunityRow = {
  community_id: string
  creator_user_id: string
  display_name: string
  status: "draft" | "active" | "frozen" | "archived" | "deleted" | "suspended"
  provisioning_state: "requested" | "provisioning" | "active" | "rotation_required" | "error"
  transfer_state: "none" | "pending" | "transferred" | "federated"
  route_slug: string | null
  namespace_verification_id: string | null
  pending_namespace_verification_session_id: string | null
  primary_database_binding_id: string | null
  projected_follower_count: number | null
  created_at: string
  updated_at: string
}

export type CommunityDatabaseBindingRow = {
  community_database_binding_id: string
  community_id: string
  binding_role: "primary" | "read_replica" | "archive"
  organization_slug: string
  group_name: string
  group_id: string | null
  database_name: string
  database_id: string | null
  database_url: string
  location: string | null
  status: "active" | "inactive" | "pending_transfer" | "superseded" | "error"
  transferred_at: string | null
  created_at: string
  updated_at: string
}

export type CommunityDbCredentialRow = {
  community_db_credential_id: string
  community_database_binding_id: string
  credential_kind: "database_token" | "group_token"
  token_name: string
  encrypted_token: string
  encryption_key_version: number
  token_scope: "database" | "group"
  status: "active" | "superseded" | "invalidated"
  issued_at: string
  invalidated_at: string | null
  expires_at: string | null
  created_at: string
  updated_at: string
}

export type JobRow = {
  job_id: string
  job_type: Job["job_type"]
  job_scope: "platform" | "community"
  community_id: string | null
  subject_type: string
  subject_id: string
  status: Job["status"]
  payload_json: string | null
  result_ref: string | null
  error_code: string | null
  attempt_count: number
  available_at: string | null
  created_at: string
  updated_at: string
}

export type CommunityPostProjectionRow = {
  projection_id: string
  community_id: string
  source_post_id: string
  author_user_id: string | null
  identity_mode: "public" | "anonymous"
  post_type: Post["post_type"]
  status: Post["status"]
  visibility: Post["visibility"]
  source_created_at: string
  projected_payload_json: string
  upvote_count: number
  downvote_count: number
  comment_count: number
  like_count: number
  projection_version: number
  created_at: string
  updated_at: string
}

export type CommunityMembershipProjectionRow = {
  projection_id: string
  community_id: string
  user_id: string
  membership_state: "not_member" | "pending_request" | "member" | "banned"
  role_summary_json: string | null
  source_updated_at: string
  created_at: string
  updated_at: string
}

export type CommunityFollowProjectionRow = {
  projection_id: string
  community_id: string
  user_id: string
  follow_state: "active" | "inactive"
  source_updated_at: string
  unfollowed_at: string | null
  created_at: string
  updated_at: string
}

export type CommunityCommentProjectionRow = {
  projection_id: string
  community_id: string
  thread_root_post_id: string
  source_comment_id: string
  parent_comment_id: string | null
  depth: number
  status: "published" | "hidden" | "removed" | "deleted"
  source_created_at: string
  created_at: string
  updated_at: string
}

export function toCommunityRow(row: unknown): CommunityRow {
  return {
    community_id: requiredString(row, "community_id"),
    creator_user_id: requiredString(row, "creator_user_id"),
    display_name: requiredString(row, "display_name"),
    status: requiredString(row, "status") as CommunityRow["status"],
    provisioning_state: requiredString(row, "provisioning_state") as CommunityRow["provisioning_state"],
    transfer_state: requiredString(row, "transfer_state") as CommunityRow["transfer_state"],
    route_slug: stringOrNull(rowValue(row, "route_slug")),
    namespace_verification_id: stringOrNull(rowValue(row, "namespace_verification_id")),
    pending_namespace_verification_session_id: stringOrNull(rowValue(row, "pending_namespace_verification_session_id")),
    primary_database_binding_id: stringOrNull(rowValue(row, "primary_database_binding_id")),
    projected_follower_count: typeof rowValue(row, "projected_follower_count") === "number"
      ? rowValue(row, "projected_follower_count") as number
      : null,
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toCommunityDatabaseBindingRow(row: unknown): CommunityDatabaseBindingRow {
  return {
    community_database_binding_id: requiredString(row, "community_database_binding_id"),
    community_id: requiredString(row, "community_id"),
    binding_role: requiredString(row, "binding_role") as CommunityDatabaseBindingRow["binding_role"],
    organization_slug: requiredString(row, "organization_slug"),
    group_name: requiredString(row, "group_name"),
    group_id: stringOrNull(rowValue(row, "group_id")),
    database_name: requiredString(row, "database_name"),
    database_id: stringOrNull(rowValue(row, "database_id")),
    database_url: requiredString(row, "database_url"),
    location: stringOrNull(rowValue(row, "location")),
    status: requiredString(row, "status") as CommunityDatabaseBindingRow["status"],
    transferred_at: stringOrNull(rowValue(row, "transferred_at")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toCommunityDbCredentialRow(row: unknown): CommunityDbCredentialRow {
  return {
    community_db_credential_id: requiredString(row, "community_db_credential_id"),
    community_database_binding_id: requiredString(row, "community_database_binding_id"),
    credential_kind: requiredString(row, "credential_kind") as CommunityDbCredentialRow["credential_kind"],
    token_name: requiredString(row, "token_name"),
    encrypted_token: requiredString(row, "encrypted_token"),
    encryption_key_version: requiredNumber(row, "encryption_key_version"),
    token_scope: requiredString(row, "token_scope") as CommunityDbCredentialRow["token_scope"],
    status: requiredString(row, "status") as CommunityDbCredentialRow["status"],
    issued_at: requiredString(row, "issued_at"),
    invalidated_at: stringOrNull(rowValue(row, "invalidated_at")),
    expires_at: stringOrNull(rowValue(row, "expires_at")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toJobRow(row: unknown): JobRow {
  return {
    job_id: requiredString(row, "job_id"),
    job_type: requiredString(row, "job_type") as JobRow["job_type"],
    job_scope: requiredString(row, "job_scope") as JobRow["job_scope"],
    community_id: stringOrNull(rowValue(row, "community_id")),
    subject_type: requiredString(row, "subject_type"),
    subject_id: requiredString(row, "subject_id"),
    status: requiredString(row, "status") as JobRow["status"],
    payload_json: stringOrNull(rowValue(row, "payload_json")),
    result_ref: stringOrNull(rowValue(row, "result_ref")),
    error_code: stringOrNull(rowValue(row, "error_code")),
    attempt_count: requiredNumber(row, "attempt_count"),
    available_at: stringOrNull(rowValue(row, "available_at")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toCommunityPostProjectionRow(row: unknown): CommunityPostProjectionRow {
  return {
    projection_id: requiredString(row, "projection_id"),
    community_id: requiredString(row, "community_id"),
    source_post_id: requiredString(row, "source_post_id"),
    author_user_id: stringOrNull(rowValue(row, "author_user_id")),
    identity_mode: requiredString(row, "identity_mode") as CommunityPostProjectionRow["identity_mode"],
    post_type: requiredString(row, "post_type") as CommunityPostProjectionRow["post_type"],
    status: requiredString(row, "status") as CommunityPostProjectionRow["status"],
    visibility: requiredString(row, "visibility") as CommunityPostProjectionRow["visibility"],
    source_created_at: requiredString(row, "source_created_at"),
    projected_payload_json: requiredString(row, "projected_payload_json"),
    upvote_count: requiredNumber(row, "upvote_count"),
    downvote_count: requiredNumber(row, "downvote_count"),
    comment_count: requiredNumber(row, "comment_count"),
    like_count: requiredNumber(row, "like_count"),
    projection_version: requiredNumber(row, "projection_version"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toCommunityMembershipProjectionRow(row: unknown): CommunityMembershipProjectionRow {
  return {
    projection_id: requiredString(row, "projection_id"),
    community_id: requiredString(row, "community_id"),
    user_id: requiredString(row, "user_id"),
    membership_state: requiredString(row, "membership_state") as CommunityMembershipProjectionRow["membership_state"],
    role_summary_json: stringOrNull(rowValue(row, "role_summary_json")),
    source_updated_at: requiredString(row, "source_updated_at"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toCommunityFollowProjectionRow(row: unknown): CommunityFollowProjectionRow {
  return {
    projection_id: requiredString(row, "projection_id"),
    community_id: requiredString(row, "community_id"),
    user_id: requiredString(row, "user_id"),
    follow_state: requiredString(row, "follow_state") as CommunityFollowProjectionRow["follow_state"],
    source_updated_at: requiredString(row, "source_updated_at"),
    unfollowed_at: stringOrNull(rowValue(row, "unfollowed_at")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function toCommunityCommentProjectionRow(row: unknown): CommunityCommentProjectionRow {
  return {
    projection_id: requiredString(row, "projection_id"),
    community_id: requiredString(row, "community_id"),
    thread_root_post_id: requiredString(row, "thread_root_post_id"),
    source_comment_id: requiredString(row, "source_comment_id"),
    parent_comment_id: stringOrNull(rowValue(row, "parent_comment_id")),
    depth: requiredNumber(row, "depth"),
    status: requiredString(row, "status") as CommunityCommentProjectionRow["status"],
    source_created_at: requiredString(row, "source_created_at"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}
