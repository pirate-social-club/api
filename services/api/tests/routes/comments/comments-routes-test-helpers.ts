import { createClient } from "@libsql/client"
import { app } from "../../../src/index"
import { buildLocalCommunityDbUrl } from "../../../src/lib/communities/community-local-db"
import { getCommentById } from "../../../src/lib/comments/community-comment-store"
import { computeCommentSourceHash } from "../../../src/lib/localization/content-source-hash"
import type { Env } from "../../../src/types"
import { json, mintUpstreamJwt } from "../../helpers"

export function requestJson(url: string, body: unknown, env: Env, token?: string, method = "POST"): Promise<Response> {
  return Promise.resolve(app.request(
    url,
    {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  ))
}

export async function exchangeJwt(env: Env, sub: string): Promise<{ accessToken: string; userId: string }> {
  const jwt = await mintUpstreamJwt(env, { sub })
  const response = await requestJson("http://pirate.test/auth/session/exchange", {
    proof: {
      type: "jwt_based_auth",
      jwt,
    },
  }, env)
  const body = await json(response) as { access_token: string; user: { id: string } }
  return { accessToken: body.access_token, userId: body.user.id.replace(/^usr_/, "") }
}

export async function completeUniqueHumanVerification(env: Env, accessToken: string): Promise<void> {
  const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
    provider: "self",
  }, env, accessToken)
  const verificationBody = await json(verificationSession) as { id: string }
  await requestJson(
    `http://pirate.test/verification-sessions/${verificationBody.id}/complete`,
    {},
    env,
    accessToken,
  )
}

export async function prepareVerifiedNamespace(env: Env, accessToken: string): Promise<string> {
  await completeUniqueHumanVerification(env, accessToken)

  const namespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
    family: "hns",
    root_label: "CommentRoutesCoverageRoot",
  }, env, accessToken)
  const namespaceBody = await json(namespaceSession) as { id: string }
  const completed = await requestJson(
    `http://pirate.test/namespace-verification-sessions/${namespaceBody.id}/complete`,
    {},
    env,
    accessToken,
  )
  const completedBody = await json(completed) as { namespace_verification: string }
  return completedBody.namespace_verification
}

export async function createCommunity(
  env: Env,
  accessToken: string,
  displayName: string,
): Promise<{ communityId: string }> {
  const response = await requestJson("http://pirate.test/communities", {
    display_name: displayName,
    membership_mode: "request",
  }, env, accessToken)
  const body = await json(response) as { community: { id: string } }
  return { communityId: body.community.id.replace(/^com_/, "") }
}

export async function addCommunityMember(communityDbRoot: string, communityId: string, userId: string): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(communityDbRoot, communityId),
  })

  try {
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        INSERT INTO community_memberships (
          membership_id, community_id, user_id, status, joined_at, left_at, banned_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 'member', ?4, NULL, NULL, ?4, ?4
        )
        ON CONFLICT(membership_id) DO UPDATE SET
          status = excluded.status,
          joined_at = excluded.joined_at,
          left_at = excluded.left_at,
          banned_at = excluded.banned_at,
          updated_at = excluded.updated_at
      `,
      args: [`mbr_${communityId}_${userId}`, communityId, userId, now],
    })
  } finally {
    client.close()
  }
}

function rawPublicId(value: string, prefix: string): string {
  const publicPrefix = `${prefix}_`
  if (!value.startsWith(publicPrefix)) {
    return value
  }
  const stripped = value.slice(publicPrefix.length)
  return stripped.includes("_") ? stripped : value
}

export async function insertThreadSnapshot(input: {
  communityDbRoot: string
  communityId: string
  postId: string
  commentCount: number
  swarmManifestRef: string
  swarmFeedRef?: string | null
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        INSERT INTO thread_snapshots (
          thread_snapshot_id, community_id, thread_root_post_id, snapshot_seq,
          published_through_comment_created_at, comment_count, swarm_manifest_ref,
          swarm_feed_ref, created_at
        ) VALUES (
          ?1, ?2, ?3, 1,
          ?4, ?5, ?6,
          ?7, ?4
        )
      `,
      args: [
        `tsn_${input.postId}`,
        input.communityId,
        rawPublicId(input.postId, "post"),
        now,
        input.commentCount,
        input.swarmManifestRef,
        input.swarmFeedRef ?? null,
      ],
    })
  } finally {
    client.close()
  }
}

export async function insertCommentTranslation(input: {
  communityDbRoot: string
  communityId: string
  commentId: string
  locale: string
  translatedBody: string
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    const commentId = rawPublicId(input.commentId, "cmt")
    const comment = await getCommentById(client, commentId)
    const sourceHash = await computeCommentSourceHash(comment!)
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        INSERT INTO content_translations (
          content_translation_id, content_type, content_id, locale, source_hash,
          source_language, outcome, translated_body, translated_caption, provider,
          provider_model, provider_result_json, created_at, updated_at
        ) VALUES (
          ?1, 'comment', ?2, ?3, ?4,
          ?5, 'translated', ?6, NULL, 'test-provider',
          'test-model', NULL, ?7, ?7
        )
      `,
      args: [
        `ctr_${input.commentId}_${input.locale}`,
        commentId,
        input.locale,
        sourceHash,
        comment?.source_language ?? "en",
        input.translatedBody,
        now,
      ],
    })
  } finally {
    client.close()
  }
}

export async function fetchCommunityJobsByType(input: {
  communityDbRoot: string
  communityId: string
  jobType: string
}): Promise<Array<{ subject_id: string; status: string }>> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    const result = await client.execute({
      sql: `
        SELECT subject_id, status
        FROM community_jobs
        WHERE job_type = ?1
        ORDER BY created_at ASC, job_id ASC
      `,
      args: [input.jobType],
    })
    return result.rows.map((row) => ({
      subject_id: String(row.subject_id ?? ""),
      status: String(row.status ?? ""),
    }))
  } finally {
    client.close()
  }
}
