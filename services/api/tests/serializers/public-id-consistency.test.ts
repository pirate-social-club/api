import { describe, expect, test } from "bun:test"

import {
  assembleProfile,
  serializeNamespaceVerification,
  serializeNamespaceVerificationSession,
  serializeUser as serializeAuthUser,
  serializeVerificationSession,
} from "../../src/lib/auth/auth-serializers"
import { publicId } from "../../src/lib/public-ids"
import { serializeComment } from "../../src/serializers/comment"
import { serializeCommunity } from "../../src/serializers/community"
import { serializePost } from "../../src/serializers/post"
import { serializeUser } from "../../src/serializers/user"

const CREATED_AT = "2026-08-12T00:00:00.000Z"
const USER_ID = "usr_consistency"
const AGENT_ID = "agt_consistency"
const NAMESPACE_VERIFICATION_ID = "nv_consistency"

function authUser() {
  return serializeAuthUser({
    user_id: USER_ID,
    primary_wallet_attachment_id: null,
    capability_provider: null,
    verification_capabilities_json: null,
    verified_at: null,
    created_at: CREATED_AT,
  } as unknown as Parameters<typeof serializeAuthUser>[0])
}

function namespaceVerification() {
  return serializeNamespaceVerification({
    namespace_verification_id: NAMESPACE_VERIFICATION_ID,
    user_id: USER_ID,
    accepted_at: CREATED_AT,
    created_at: CREATED_AT,
    expires_at: CREATED_AT,
  } as Parameters<typeof serializeNamespaceVerification>[0])
}

describe("public ID serializer consistency", () => {
  test("usr serializers agree on one public prefix", () => {
    const user = serializeUser({
      user_id: USER_ID,
      created_at: CREATED_AT,
    } as Parameters<typeof serializeUser>[0])
    const community = serializeCommunity({
      community_id: "com_consistency",
      created_by_user_id: USER_ID,
      branding_json: "{}",
      created_at: CREATED_AT,
    } as Parameters<typeof serializeCommunity>[0])
    const profile = assembleProfile(
      {
        user_id: USER_ID,
        created_at: CREATED_AT,
      } as Parameters<typeof assembleProfile>[0],
      {
        global_handle_id: "gh_consistency",
        label_display: "operator.pirate",
        created_at: CREATED_AT,
      } as Parameters<typeof assembleProfile>[1],
    )
    const verificationSession = serializeVerificationSession({
      row: {
        user_id: USER_ID,
        requested_capabilities_json: "{}",
        verification_requirements_json: null,
        created_at: CREATED_AT,
        expires_at: CREATED_AT,
      } as Parameters<typeof serializeVerificationSession>[0]["row"],
      attestationRows: [],
    })
    const namespaceSession = serializeNamespaceVerificationSession({
      namespace_verification_session_id: "nvs_consistency",
      namespace_verification_id: NAMESPACE_VERIFICATION_ID,
      user_id: USER_ID,
      setup_nameservers_json: null,
      created_at: CREATED_AT,
      expires_at: CREATED_AT,
    } as Parameters<typeof serializeNamespaceVerificationSession>[0])
    const post = serializePost({
      post_id: "post_consistency",
      community_id: "com_consistency",
      author_user_id: USER_ID,
      identity_mode: "public",
      comments_locked_by_user_id: USER_ID,
      crosspost_source: {
        post_id: "post_source",
        community_id: "com_consistency",
        status: "published",
        author_user_id: USER_ID,
      },
      created_at: CREATED_AT,
    } as unknown as Parameters<typeof serializePost>[0])
    const comment = serializeComment({
      comment_id: "cmt_consistency",
      community_id: "com_consistency",
      thread_root_post_id: "post_consistency",
      author_user_id: USER_ID,
      authorship_mode: "human_direct",
      identity_mode: "public",
      replies_locked_by_user_id: USER_ID,
      created_at: CREATED_AT,
    } as unknown as Parameters<typeof serializeComment>[0])

    expect(user.id).toBe(community.created_by_user)
    const serializedUserIds = [
      user.id,
      authUser().id,
      profile.id,
      verificationSession.user,
      namespaceSession.user,
      namespaceVerification().user,
      post.author_user,
      post.comments_locked_by_user,
      post.crosspost_source?.author_user,
      comment.author_user,
      comment.replies_locked_by_user,
    ]
    expect(serializedUserIds).toHaveLength(11)
    expect(new Set(serializedUserIds)).toEqual(new Set([USER_ID]))
  })

  test("agt serializers agree on one public prefix", () => {
    const post = serializePost({
      post_id: "post_consistency",
      community_id: "com_consistency",
      agent_id: AGENT_ID,
      created_at: CREATED_AT,
    } as Parameters<typeof serializePost>[0])
    const comment = serializeComment({
      comment_id: "cmt_consistency",
      community_id: "com_consistency",
      thread_root_post_id: "post_consistency",
      agent_id: AGENT_ID,
      authorship_mode: "agent",
      created_at: CREATED_AT,
    } as unknown as Parameters<typeof serializeComment>[0])

    expect(post.agent).toBe(publicId(AGENT_ID, "agt"))
    expect(comment.agent).toBe(post.agent)
    expect(comment.agent).toBe(AGENT_ID)
  })

  test("nv serializers agree on one public prefix", () => {
    const community = serializeCommunity({
      community_id: "com_consistency",
      created_by_user_id: USER_ID,
      namespace_verification_id: NAMESPACE_VERIFICATION_ID,
      branding_json: "{}",
      created_at: CREATED_AT,
    } as Parameters<typeof serializeCommunity>[0])

    expect(namespaceVerification().id).toBe(community.namespace_verification)
    expect(community.namespace_verification).toBe(publicId(NAMESPACE_VERIFICATION_ID, "nv"))
    expect(community.namespace_verification).toBe(NAMESPACE_VERIFICATION_ID)
  })
})
