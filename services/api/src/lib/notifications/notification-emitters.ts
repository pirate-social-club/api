import { nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { insertNotificationEvent, insertNotificationReceipt } from "./notification-event-store"
import {
  buildActorIdentityPayload,
  buildActorIdentityPayloadFromSnapshot,
  hasNotificationEventDedupeKey,
  type NotificationActorIdentity,
} from "./notification-event-helpers"
import { trackNotificationGeneratedSafely } from "./notification-tracking"
import type { Env } from "../../env"

async function resolveActorIdentityPayload(input: {
  client: ReturnType<typeof getControlPlaneClient>
  identity?: NotificationActorIdentity | null
  userId: string
}): Promise<Record<string, unknown>> {
  return input.identity
    ? buildActorIdentityPayloadFromSnapshot(input.identity)
    : buildActorIdentityPayload(input.client, input.userId)
}

function resolveNotificationActorUserId(actorUserId: string, identity?: NotificationActorIdentity | null): string | null {
  return identity?.exposeActorUser === false ? null : actorUserId
}

export async function emitCommentReply(input: {
  env: Env
  actorIdentity?: NotificationActorIdentity | null
  actorUserId: string
  recipientUserId: string
  communityId: string
  commentExcerpt?: string | null
  postTitle?: string | null
  threadRootPostId: string
  parentCommentId: string
  replyCommentId: string
}): Promise<void> {
  if (input.actorUserId === input.recipientUserId) return

  const client = getControlPlaneClient(input.env)
  try {
    const now = nowIso()
    const actorPayload = await resolveActorIdentityPayload({
      client,
      identity: input.actorIdentity,
      userId: input.actorUserId,
    })
    const dedupeKey = `comment_reply:${input.replyCommentId}:${input.recipientUserId}`
    const alreadyExists = await hasNotificationEventDedupeKey(client, dedupeKey)
    const eventId = await insertNotificationEvent({
      executor: client,
      type: "comment_reply",
      actorUserId: resolveNotificationActorUserId(input.actorUserId, input.actorIdentity),
      subjectType: "comment",
      subjectId: input.parentCommentId,
      objectType: "comment",
      objectId: input.replyCommentId,
      payload: {
        ...actorPayload,
        community_id: input.communityId,
        comment_id: input.replyCommentId,
        comment_excerpt: input.commentExcerpt ?? null,
        parent_comment_id: input.parentCommentId,
        post_title: input.postTitle ?? null,
        target_path: `/p/${input.threadRootPostId}?comment=${encodeURIComponent(input.replyCommentId)}`,
        thread_root_post_id: input.threadRootPostId,
      },
      dedupeKey,
      createdAt: now,
    })
    await insertNotificationReceipt({
      executor: client,
      eventId,
      recipientUserId: input.recipientUserId,
      createdAt: now,
    })
    if (!alreadyExists) {
      await trackNotificationGeneratedSafely(input.env, client, {
        userId: input.recipientUserId,
        notificationType: "comment_reply",
        notificationKind: "activity",
        communityId: input.communityId,
        postId: input.threadRootPostId,
        commentId: input.replyCommentId,
      })
    }
  } finally {
    client.close?.()
  }
}

export async function emitPostCommented(input: {
  env: Env
  actorIdentity?: NotificationActorIdentity | null
  actorUserId: string
  postAuthorUserId: string
  communityId: string
  commentExcerpt?: string | null
  postTitle?: string | null
  postId: string
  commentId: string
}): Promise<void> {
  if (input.actorUserId === input.postAuthorUserId) return

  const client = getControlPlaneClient(input.env)
  try {
    const now = nowIso()
    const actorPayload = await resolveActorIdentityPayload({
      client,
      identity: input.actorIdentity,
      userId: input.actorUserId,
    })
    const dedupeKey = `post_commented:${input.commentId}:${input.postAuthorUserId}`
    const alreadyExists = await hasNotificationEventDedupeKey(client, dedupeKey)
    const eventId = await insertNotificationEvent({
      executor: client,
      type: "post_commented",
      actorUserId: resolveNotificationActorUserId(input.actorUserId, input.actorIdentity),
      subjectType: "post",
      subjectId: input.postId,
      objectType: "comment",
      objectId: input.commentId,
      payload: {
        ...actorPayload,
        community_id: input.communityId,
        comment_id: input.commentId,
        comment_excerpt: input.commentExcerpt ?? null,
        post_title: input.postTitle ?? null,
        target_path: `/p/${input.postId}?comment=${encodeURIComponent(input.commentId)}`,
        thread_root_post_id: input.postId,
      },
      dedupeKey,
      createdAt: now,
    })
    await insertNotificationReceipt({
      executor: client,
      eventId,
      recipientUserId: input.postAuthorUserId,
      createdAt: now,
    })
    if (!alreadyExists) {
      await trackNotificationGeneratedSafely(input.env, client, {
        userId: input.postAuthorUserId,
        notificationType: "post_commented",
        notificationKind: "activity",
        communityId: input.communityId,
        postId: input.postId,
        commentId: input.commentId,
      })
    }
  } finally {
    client.close?.()
  }
}

async function emitRoyaltyEarned(input: {
  env: Env
  recipientUserId: string
  communityId: string
  assetId: string
  storyIpId: string
  amountWipWei: string
  buyerWalletAddress?: string | null
  txHash?: string | null
  purchaseId: string
  title?: string | null
}): Promise<void> {
  const client = getControlPlaneClient(input.env)
  try {
    const now = nowIso()
    const dedupeKey = `royalty_earned:${input.purchaseId}:${input.assetId}`
    const alreadyExists = await hasNotificationEventDedupeKey(client, dedupeKey)
    const eventId = await insertNotificationEvent({
      executor: client,
      type: "royalty_earned",
      actorUserId: null,
      subjectType: "asset",
      subjectId: input.assetId,
      objectType: "purchase",
      objectId: input.purchaseId,
      payload: {
        community_id: input.communityId,
        asset_id: input.assetId,
        purchase: `pur_${input.purchaseId}`,
        title: input.title ?? null,
        amount_wip_wei: input.amountWipWei,
        story_ip_id: input.storyIpId,
        buyer_wallet_address: input.buyerWalletAddress ?? null,
        tx_hash: input.txHash ?? null,
        target_path: "/inbox?tab=royalties",
      },
      dedupeKey,
      createdAt: now,
    })
    await insertNotificationReceipt({
      executor: client,
      eventId,
      recipientUserId: input.recipientUserId,
      createdAt: now,
    })
    if (!alreadyExists) {
      await trackNotificationGeneratedSafely(input.env, client, {
        userId: input.recipientUserId,
        notificationType: "royalty_earned",
        notificationKind: "activity",
        communityId: input.communityId,
      })
    }
  } finally {
    client.close?.()
  }
}

export async function emitRoyaltyEarnedBatch(input: {
  env: Env
  buyerUserId: string
  events: Array<{
    recipientUserId: string
    communityId: string
    assetId: string
    storyIpId: string
    amountWipWei: string
    buyerWalletAddress?: string | null
    txHash?: string | null
    purchaseId: string
    title?: string | null
  }>
}): Promise<void> {
  for (const event of input.events) {
    if (event.recipientUserId === input.buyerUserId) {
      continue
    }
    await emitRoyaltyEarned({
      env: input.env,
      ...event,
    })
  }
}
