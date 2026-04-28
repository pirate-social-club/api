import type { Client } from "../sql-client"
import {
  getCommunityCommentProjectionRowByCommentId,
  getCommunityPostProjectionRowByPostId,
  listCommunityFollowProjectionRowsByUserId,
  listCommunityMembershipProjectionRowsByUserId,
} from "../auth/auth-db-queries"
import type {
  CommunityCommentProjectionRow,
  CommunityFollowProjectionRow,
  CommunityMembershipProjectionRow,
  CommunityPostProjectionRow,
} from "../auth/auth-db-rows"

export async function getCommunityPostProjectionByPostId(
  client: Client,
  postId: string,
): Promise<CommunityPostProjectionRow | null> {
  return getCommunityPostProjectionRowByPostId(client, postId)
}

export async function getCommunityCommentProjectionByCommentId(
  client: Client,
  commentId: string,
): Promise<CommunityCommentProjectionRow | null> {
  return getCommunityCommentProjectionRowByCommentId(client, commentId)
}

export async function listCommunityMembershipProjectionsByUserId(
  client: Client,
  userId: string,
): Promise<CommunityMembershipProjectionRow[]> {
  return listCommunityMembershipProjectionRowsByUserId(client, userId)
}

export async function listCommunityFollowProjectionsByUserId(
  client: Client,
  userId: string,
): Promise<CommunityFollowProjectionRow[]> {
  return listCommunityFollowProjectionRowsByUserId(client, userId)
}
