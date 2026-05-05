import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
  completeUniqueHumanVerification,
  exchangeJwt,
  requestJson,
} from "./community-routes-test-helpers"
import { encryptCommunityDbCredential } from "../../../src/lib/communities/community-db-credential-crypto"
import {
  createSelfVerifiedSession,
  withFetchMock,
} from "../verification/verification-test-helpers"

const ADMIN_TOKEN = "test-admin-token-abc123"

let cleanup: (() => Promise<void>) | null = null

beforeEach(() => {
  resetRuntimeCaches()
})

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("admin auth middleware", () => {
  test("admin token can validate against admin health route", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const actingSession = await exchangeJwt(ctx.env, "admin-health-actor")

    const health = await Promise.resolve(app.request(
      "http://pirate.test/communities/admin/health",
      {
        method: "GET",
        headers: {
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": actingSession.userId,
        },
      },
      ctx.env,
    ))
    expect(health.status).toBe(200)
    const healthBody = await json(health) as {
      ok: boolean
      mode: string
      acting_user_id: string
    }
    expect(healthBody.ok).toBe(true)
    expect(healthBody.mode).toBe("admin")
    expect(healthBody.acting_user_id).toBe(actingSession.userId)
  })

  test("admin token can migrate a provisioned community database", async () => {
    const wrapKey = "11".repeat(32)
    const operatorToken = "operator-token"
    let operatorRequestBody: Record<string, unknown> | null = null
    const operator = {
      fetch: async (request: Request | string) => {
        const normalizedRequest = typeof request === "string" ? new Request(request) : request
        expect(new URL(normalizedRequest.url).pathname).toBe("/internal/v0/community-provisioning/migrate")
        expect(normalizedRequest.headers.get("authorization")).toBe(`Bearer ${operatorToken}`)
        operatorRequestBody = await normalizedRequest.json() as Record<string, unknown>
        return new Response(JSON.stringify({
          applied: 1,
          skipped: 61,
        }), {
          headers: { "content-type": "application/json" },
        })
      },
    } as Fetcher
    const ctx = await createRouteTestContext({
      PIRATE_ADMIN_TOKEN: ADMIN_TOKEN,
      COMMUNITY_PROVISION_OPERATOR: operator,
      COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN: operatorToken,
      TURSO_COMMUNITY_DB_WRAP_KEY: wrapKey,
    })
    cleanup = ctx.cleanup

    const actingSession = await exchangeJwt(ctx.env, "admin-db-migrate-actor")
    const now = new Date().toISOString()
    await ctx.client.batch([
      {
        sql: `
          INSERT INTO communities (
            community_id, creator_user_id, display_name, membership_mode, status, provisioning_state,
            transfer_state, route_slug, namespace_verification_id, pending_namespace_verification_session_id,
            primary_database_binding_id, created_at, updated_at
          ) VALUES (
            'cmt_admin_migrate', ?1, 'Admin Migrate', 'request', 'active', 'active',
            'none', NULL, NULL, NULL,
            'cdb_admin_migrate', ?2, ?2
          )
        `,
        args: [actingSession.userId, now],
      },
      {
        sql: `
          INSERT INTO community_database_bindings (
            community_database_binding_id, community_id, binding_role, organization_slug, group_name,
            group_id, database_name, database_id, database_url, location, requires_credentials,
            status, transferred_at, created_at, updated_at
          ) VALUES (
            'cdb_admin_migrate', 'cmt_admin_migrate', 'primary', 'pirate-prod', 'region-aws-us-east-1',
            'grp_admin_migrate', 'main-cmt-admin-migrate', 'db_admin_migrate',
            'libsql://main-cmt-admin-migrate-pirate-prod.aws-us-east-1.turso.io',
            'aws-us-east-1', 1,
            'active', NULL, ?1, ?1
          )
        `,
        args: [now],
      },
      {
        sql: `
          INSERT INTO community_db_credentials (
            community_db_credential_id, community_database_binding_id, credential_kind, token_name,
            encrypted_token, encryption_key_version, token_scope, status, issued_at, invalidated_at,
            expires_at, created_at, updated_at
          ) VALUES (
            'cdc_admin_migrate', 'cdb_admin_migrate', 'database_token', 'worker-cmt_admin_migrate-v1',
            ?1, 1, 'database', 'active', ?2, NULL,
            NULL, ?2, ?2
          )
        `,
        args: [
          encryptCommunityDbCredential({
            plaintextToken: "db-token-admin-migrate",
            wrapKey,
          }),
          now,
        ],
      },
    ])

    const response = await app.request(
      "http://pirate.test/communities/cmt_admin_migrate/admin/database-migrations",
      {
        method: "POST",
        headers: {
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": actingSession.userId,
        },
      },
      ctx.env,
    )

    expect(response.status).toBe(200)
    expect(operatorRequestBody).toEqual({
      database_url: "libsql://main-cmt-admin-migrate-pirate-prod.aws-us-east-1.turso.io",
      database_auth_token: "db-token-admin-migrate",
    })
    const body = await json(response) as Record<string, unknown>
    expect(body).toEqual({
      community: "com_cmt_admin_migrate",
      database_url: "libsql://main-cmt-admin-migrate-pirate-prod.aws-us-east-1.turso.io",
      applied: 1,
      skipped: 61,
    })
  })

  async function createAdminLinkPreviewFixture(input: {
    ctx: Awaited<ReturnType<typeof createRouteTestContext>>
    postType: "link" | "text"
    idSuffix: string
  }): Promise<{
    actingUserId: string
    communityId: string
    ownerAccessToken: string
    postId: string
  }> {
    const ownerSession = await exchangeJwt(input.ctx.env, `admin-link-preview-owner-${input.idSuffix}`)
    await completeUniqueHumanVerification(input.ctx.env, ownerSession.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: `Admin Link Preview ${input.idSuffix}`,
      membership_mode: "request",
      handle_policy: { policy_template: "standard" },
    }, input.ctx.env, ownerSession.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }
    const communityId = communityCreateBody.community.id.replace(/^com_/, "")

    const actingSession = await exchangeJwt(input.ctx.env, `admin-link-preview-actor-${input.idSuffix}`)
    const postCreate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": actingSession.userId,
        },
        body: JSON.stringify({
          post_type: input.postType,
          idempotency_key: `admin-link-preview-post-${input.idSuffix}`,
          title: "Original title",
          body: "Original body",
          ...(input.postType === "link" ? { link_url: "https://example.com/story" } : {}),
        }),
      },
      input.ctx.env,
    ))
    expect(postCreate.status).toBe(201)
    const postCreateBody = await json(postCreate) as { id: string }

    return {
      actingUserId: actingSession.userId,
      communityId,
      ownerAccessToken: ownerSession.accessToken,
      postId: postCreateBody.id,
    }
  }

  test("admin token can update link post preview metadata", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup
    const fixture = await createAdminLinkPreviewFixture({ ctx, postType: "link", idSuffix: "happy" })

    const update = await Promise.resolve(app.request(
      `http://pirate.test/communities/${fixture.communityId}/posts/${fixture.postId}/link-preview`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": fixture.actingUserId,
        },
        body: JSON.stringify({
          title: "Manual preview title",
          image_url: "https://cdn.example.com/preview.jpg",
        }),
      },
      ctx.env,
    ))

    expect(update.status).toBe(200)
    const updateBody = await json(update) as {
      link_enrichment: {
        provider: string
        title: string
        image_url: string
      } | null
      link_og_image_url: string | null
      link_og_title: string | null
    }
    expect(updateBody.link_og_title).toBe("Manual preview title")
    expect(updateBody.link_og_image_url).toBe("https://cdn.example.com/preview.jpg")
    expect(updateBody.link_enrichment?.provider).toBe("manual")
    expect(updateBody.link_enrichment?.title).toBe("Manual preview title")
    expect(updateBody.link_enrichment?.image_url).toBe("https://cdn.example.com/preview.jpg")

    const auditRows = await ctx.client.execute({
      sql: `
        SELECT actor_type, actor_id, action, target_type, target_id, community_id, metadata_json
        FROM audit_log
        WHERE community_id = ?1 AND action = 'community.admin_link_preview_updated'
      `,
      args: [fixture.communityId],
    })
    expect(auditRows.rows).toHaveLength(1)
    const auditRow = auditRows.rows[0]!
    expect(auditRow.actor_type).toBe("operator")
    expect(auditRow.actor_id).toBe("admin-token")
    expect(auditRow.target_type).toBe("post")
    expect(auditRow.target_id).toBe(fixture.postId.replace(/^post_/, ""))
    const metadata = JSON.parse(String(auditRow.metadata_json)) as {
      acting_user_id: string
      link_og_image_url: string
      link_og_title: string
    }
    expect(metadata.acting_user_id).toBe(fixture.actingUserId)
    expect(metadata.link_og_title).toBe("Manual preview title")
    expect(metadata.link_og_image_url).toBe("https://cdn.example.com/preview.jpg")

    const enrichmentRows = await ctx.client.execute({
      sql: `
        SELECT provider, status, normalized_url, canonical_url, title, image_url, markdown
        FROM link_enrichments
        WHERE normalized_url = ?1
      `,
      args: ["https://example.com/story"],
    })
    expect(enrichmentRows.rows).toHaveLength(1)
    expect(enrichmentRows.rows[0]?.provider).toBe("manual")
    expect(enrichmentRows.rows[0]?.status).toBe("ready")
    expect(enrichmentRows.rows[0]?.canonical_url).toBe("https://example.com/story")
    expect(enrichmentRows.rows[0]?.title).toBe("Manual preview title")
    expect(enrichmentRows.rows[0]?.image_url).toBe("https://cdn.example.com/preview.jpg")
    expect(enrichmentRows.rows[0]?.markdown).toBeNull()
  })

  test("link preview metadata update rejects non-link posts", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup
    const fixture = await createAdminLinkPreviewFixture({ ctx, postType: "text", idSuffix: "text" })

    const update = await Promise.resolve(app.request(
      `http://pirate.test/communities/${fixture.communityId}/posts/${fixture.postId}/link-preview`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": fixture.actingUserId,
        },
        body: JSON.stringify({
          title: "Manual preview title",
          image_url: "https://cdn.example.com/preview.jpg",
        }),
      },
      ctx.env,
    ))

    expect(update.status).toBe(400)
    const updateBody = await json(update) as { code: string; message: string }
    expect(updateBody.code).toBe("bad_request")
    expect(updateBody.message).toBe("link preview can only be updated for link posts")
  })

  test("link preview metadata update rejects invalid image URLs", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup
    const fixture = await createAdminLinkPreviewFixture({ ctx, postType: "link", idSuffix: "invalid-url" })

    const update = await Promise.resolve(app.request(
      `http://pirate.test/communities/${fixture.communityId}/posts/${fixture.postId}/link-preview`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": fixture.actingUserId,
        },
        body: JSON.stringify({
          title: "Manual preview title",
          image_url: "http://cdn.example.com/preview.jpg",
        }),
      },
      ctx.env,
    ))

    expect(update.status).toBe(400)
    const updateBody = await json(update) as { code: string; message: string }
    expect(updateBody.code).toBe("bad_request")
    expect(updateBody.message).toBe("image_url must be a valid HTTPS URL")
  })

  test("link preview metadata update rejects posts from a different community", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup
    const fixture = await createAdminLinkPreviewFixture({ ctx, postType: "link", idSuffix: "cross-a" })
    const otherFixture = await createAdminLinkPreviewFixture({ ctx, postType: "link", idSuffix: "cross-b" })

    const update = await Promise.resolve(app.request(
      `http://pirate.test/communities/${otherFixture.communityId}/posts/${fixture.postId}/link-preview`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": fixture.actingUserId,
        },
        body: JSON.stringify({
          title: "Manual preview title",
          image_url: "https://cdn.example.com/preview.jpg",
        }),
      },
      ctx.env,
    ))

    expect(update.status).toBe(404)
    const updateBody = await json(update) as { code: string; message: string }
    expect(updateBody.code).toBe("not_found")
    expect(updateBody.message).toBe("Post not found")
  })

  test("link preview metadata update requires an admin token", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup
    const fixture = await createAdminLinkPreviewFixture({ ctx, postType: "link", idSuffix: "non-admin" })

    const update = await Promise.resolve(app.request(
      `http://pirate.test/communities/${fixture.communityId}/posts/${fixture.postId}/link-preview`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${fixture.ownerAccessToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "Manual preview title",
          image_url: "https://cdn.example.com/preview.jpg",
        }),
      },
      ctx.env,
    ))

    expect(update.status).toBe(403)
    const updateBody = await json(update) as { code: string; message: string }
    expect(updateBody.code).toBe("eligibility_failed")
    expect(updateBody.message).toBe("Admin token required")
  })

  test("admin token can update community settings without being the owner", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const ownerSession = await exchangeJwt(ctx.env, "admin-test-community-owner")
    await completeUniqueHumanVerification(ctx.env, ownerSession.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Admin Test Club",
membership_mode: "request",
      handle_policy: { policy_template: "standard" },
    }, ctx.env, ownerSession.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }
    const communityId = communityCreateBody.community.id.replace(/^com_/, "")

    const otherSession = await exchangeJwt(ctx.env, "admin-test-acting-user")
    const actingUserId = otherSession.userId

    const rulesUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityId}/rules`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": actingUserId,
        },
        body: JSON.stringify({
          rules: [
            { title: "Be respectful", body: "Treat others with respect", report_reason: "Be respectful", status: "active" },
          ],
        }),
      },
      ctx.env,
    ))
    expect(rulesUpdate.status).toBe(200)
    const rulesBody = await json(rulesUpdate) as {
      id: string
    }
    expect(rulesBody.id).toBe(`com_${communityId}`)

    const auditRows = await ctx.client.execute({
      sql: `
        SELECT actor_type, actor_id, action, target_type, target_id, community_id, metadata_json
        FROM audit_log
        WHERE community_id = ?1 AND action = 'community.rules_updated'
      `,
      args: [communityId],
    })
    expect(auditRows.rows).toHaveLength(1)
    const auditRow = auditRows.rows[0]!
    expect(auditRow.actor_type).toBe("operator")
    expect(auditRow.actor_id).toBe("admin-token")
    const metadata = JSON.parse(String(auditRow.metadata_json)) as {
      scope: string
      acting_user_id: string
      owner_user_id: string
    }
    expect(metadata.scope).toBe("full")
    expect(metadata.acting_user_id).toBe(actingUserId)
    expect(metadata.owner_user_id).toBe(ownerSession.userId)
  })

  test("admin token can set gates on another users community", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const ownerSession = await exchangeJwt(ctx.env, "admin-gates-owner")
    await completeUniqueHumanVerification(ctx.env, ownerSession.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Admin Gates Club",
membership_mode: "request",
      handle_policy: { policy_template: "standard" },
    }, ctx.env, ownerSession.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }
    const communityId = communityCreateBody.community.id.replace(/^com_/, "")

    const otherSession = await exchangeJwt(ctx.env, "admin-gates-actor")
    const actingUserId = otherSession.userId

    const gatesUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityId}/gates`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": actingUserId,
        },
        body: JSON.stringify({
          membership_mode: "gated",
          default_age_gate_policy: "none",
          allow_anonymous_identity: false,
          gate_policy: {
            version: 1,
            expression: {
              op: "gate",
              gate: {
                type: "unique_human",
                provider: "self",
              },
            },
          },
        }),
      },
      ctx.env,
    ))
    expect(gatesUpdate.status).toBe(200)
    const gatesBody = await json(gatesUpdate) as {
      membership_mode: string
      gate_policy?: { expression?: { gate?: { type?: string } } } | null
    }
    expect(gatesBody.membership_mode).toBe("gated")
    expect(gatesBody.gate_policy?.expression?.gate?.type).toBe("unique_human")
  })

  test("admin token can create seed posts on another users community", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const ownerSession = await exchangeJwt(ctx.env, "admin-seed-post-owner")
    await completeUniqueHumanVerification(ctx.env, ownerSession.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Admin Seed Post Club",
membership_mode: "request",
      handle_policy: { policy_template: "standard" },
    }, ctx.env, ownerSession.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }
    const communityId = communityCreateBody.community.id.replace(/^com_/, "")

    const otherSession = await exchangeJwt(ctx.env, "admin-seed-post-actor")
    const actingUserId = otherSession.userId

    const seedPost = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": actingUserId,
          "x-admin-operation-class": "launch_seed",
        },
        body: JSON.stringify({
          post_type: "text",
          identity_mode: "public",
          idempotency_key: "admin-test-seed-001",
          title: "Welcome",
          body: "Welcome to the community!",
        }),
      },
      ctx.env,
    ))
    expect(seedPost.status === 201 || seedPost.status === 202).toBe(true)
    const postBody = await json(seedPost) as {
      id: string
      status: string
    }
    expect(postBody.id).toBeTruthy()

    const auditRows = await ctx.client.execute({
      sql: `
        SELECT actor_type, actor_id, action, target_type, target_id, metadata_json
        FROM audit_log
        WHERE action = 'community.seed_post_created'
      `,
      args: [],
    })
    expect(auditRows.rows).toHaveLength(1)
    const auditRow = auditRows.rows[0]!
    expect(auditRow.actor_type).toBe("operator")
    expect(auditRow.actor_id).toBe("admin-token")
    const metadata = JSON.parse(String(auditRow.metadata_json)) as {
      operation_class: string
      acting_user_id: string
      idempotency_key: string
    }
    expect(metadata.operation_class).toBe("launch_seed")
    expect(metadata.acting_user_id).toBe(actingUserId)
    expect(metadata.idempotency_key).toBe("admin-test-seed-001")

    const seedComment = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityId}/posts/${postBody.id}/comments`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": actingUserId,
          "x-admin-operation-class": "launch_seed",
        },
        body: JSON.stringify({
          idempotency_key: "admin-test-seed-comment-001",
          body: "Glad to be here.",
          identity_mode: "public",
        }),
      },
      ctx.env,
    ))
    expect(seedComment.status).toBe(201)
    const commentBody = await json(seedComment) as { id: string }
    expect(commentBody.id).toBeTruthy()
    const duplicateSeedComment = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityId}/posts/${postBody.id}/comments`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": actingUserId,
          "x-admin-operation-class": "launch_seed",
        },
        body: JSON.stringify({
          idempotency_key: "admin-test-seed-comment-001",
          body: "Glad to be here.",
          identity_mode: "public",
        }),
      },
      ctx.env,
    ))
    expect(duplicateSeedComment.status).toBe(201)
    const duplicateCommentBody = await json(duplicateSeedComment) as { id: string }
    expect(duplicateCommentBody.id).toBe(commentBody.id)

    const commentAuditRows = await ctx.client.execute({
      sql: `
        SELECT actor_type, actor_id, action, target_type, target_id, metadata_json
        FROM audit_log
        WHERE action = 'community.seed_comment_created'
      `,
      args: [],
    })
    expect(commentAuditRows.rows).toHaveLength(2)

    const postVote = await Promise.resolve(app.request(
      `http://pirate.test/posts/${postBody.id}/vote`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": actingUserId,
        },
        body: JSON.stringify({ value: 1 }),
      },
      ctx.env,
    ))
    expect(postVote.status).toBe(200)
    const postVoteAuditRows = await ctx.client.execute({
      sql: `
        SELECT action, target_type, target_id, community_id, metadata_json
        FROM audit_log
        WHERE action = 'community.admin_post_vote_cast'
      `,
      args: [],
    })
    expect(postVoteAuditRows.rows).toHaveLength(1)

    const commentVote = await Promise.resolve(app.request(
      `http://pirate.test/comments/${commentBody.id}/vote`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": actingUserId,
        },
        body: JSON.stringify({ value: 1 }),
      },
      ctx.env,
    ))
    expect(commentVote.status).toBe(200)
    const commentVoteAuditRows = await ctx.client.execute({
      sql: `
        SELECT action, target_type, target_id, community_id, metadata_json
        FROM audit_log
        WHERE action = 'community.admin_comment_vote_cast'
      `,
      args: [],
    })
    expect(commentVoteAuditRows.rows).toHaveLength(1)

    const profileUpdate = await Promise.resolve(app.request(
      "http://pirate.test/profiles/me",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
          "x-admin-as-user-id": actingUserId,
        },
        body: JSON.stringify({ display_name: "Seed Operator" }),
      },
      ctx.env,
    ))
    expect(profileUpdate.status).toBe(200)
    const profileAuditRows = await ctx.client.execute({
      sql: `
        SELECT action, target_type, target_id, community_id, metadata_json
        FROM audit_log
        WHERE action = 'community.admin_profile_updated'
      `,
      args: [],
    })
    expect(profileAuditRows.rows).toHaveLength(1)
  })

  test("wrong admin token is rejected", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const ownerSession = await exchangeJwt(ctx.env, "admin-wrong-token-owner")
    await completeUniqueHumanVerification(ctx.env, ownerSession.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Wrong Token Club",
membership_mode: "request",
      handle_policy: { policy_template: "standard" },
    }, ctx.env, ownerSession.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    const rulesUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/rules`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": "wrong-token",
          "x-admin-as-user-id": ownerSession.userId,
        },
        body: JSON.stringify({
          rules: [{ title: "Test", body: "Test", report_reason: "Test", status: "active" }],
        }),
      },
      ctx.env,
    ))
    expect(rulesUpdate.status).toBe(401)
  })

  test("admin token can start and read namespace verification for the acting user", async () => {
    const ctx = await createRouteTestContext({
      PIRATE_ADMIN_TOKEN: ADMIN_TOKEN,
      HNS_VERIFIER_BASE_URL: "http://hns-verifier.test",
      HNS_VERIFIER_AUTH_TOKEN: "test-hns-token",
    })
    cleanup = ctx.cleanup

    const actingSession = await exchangeJwt(ctx.env, "admin-namespace-actor")
    await createSelfVerifiedSession(ctx.env, actingSession.accessToken)

    const originalFetch = globalThis.fetch
    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://hns-verifier.test") && url.includes("/inspect-public?")) {
        return new Response(JSON.stringify({
          zone_exists: false,
          challenge_present: false,
          nameservers: ["ns1.pirate.sc."],
          observation_provider: "web3dns_json_doh",
          failure_reason: "zone_not_provisioned",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }

      return originalFetch(input, init)
    }, async () => {
      const created = await Promise.resolve(app.request(
        "http://pirate.test/namespace-verification-sessions",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-admin-token": ADMIN_TOKEN,
            "x-admin-as-user-id": actingSession.userId,
          },
          body: JSON.stringify({
            family: "hns",
            root_label: "AdminVerifierRoot",
          }),
        },
        ctx.env,
      ))
      expect(created.status).toBe(201)
      const createdBody = await json(created) as {
        id: string
        status: string
        challenge_host: string | null
        challenge_txt_value: string | null
        setup_nameservers: string[] | null
      }
      expect(createdBody.status).toBe("challenge_required")
      expect(createdBody.challenge_host).toBe("adminverifierroot")
      expect(typeof createdBody.challenge_txt_value).toBe("string")
      expect(createdBody.setup_nameservers).toEqual(["ns1.pirate.sc."])

      const fetched = await Promise.resolve(app.request(
        `http://pirate.test/namespace-verification-sessions/${createdBody.id}`,
        {
          method: "GET",
          headers: {
            "x-admin-token": ADMIN_TOKEN,
            "x-admin-as-user-id": actingSession.userId,
          },
        },
        ctx.env,
      ))
      expect(fetched.status).toBe(200)
      const fetchedBody = await json(fetched) as {
        status: string
        challenge_host: string | null
        challenge_txt_value: string | null
        setup_nameservers: string[] | null
      }
      expect(fetchedBody.status).toBe("challenge_required")
      expect(fetchedBody.challenge_host).toBe("adminverifierroot")
      expect(fetchedBody.challenge_txt_value).toBe(createdBody.challenge_txt_value)
      expect(fetchedBody.setup_nameservers).toEqual(["ns1.pirate.sc."])
    })
  })

  test("admin token without as-user-id is rejected", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const ownerSession = await exchangeJwt(ctx.env, "admin-no-user-id-owner")
    await completeUniqueHumanVerification(ctx.env, ownerSession.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "No User ID Club",
membership_mode: "request",
      handle_policy: { policy_template: "standard" },
    }, ctx.env, ownerSession.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    const rulesUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/rules`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": ADMIN_TOKEN,
        },
        body: JSON.stringify({
          rules: [{ title: "Test", body: "Test", report_reason: "Test", status: "active" }],
        }),
      },
      ctx.env,
    ))
    expect(rulesUpdate.status).toBe(401)
  })

  test("non-owner without admin token cannot update settings", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const ownerSession = await exchangeJwt(ctx.env, "admin-non-owner-owner")
    await completeUniqueHumanVerification(ctx.env, ownerSession.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Non Owner Club",
membership_mode: "request",
      handle_policy: { policy_template: "standard" },
    }, ctx.env, ownerSession.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    const strangerSession = await exchangeJwt(ctx.env, "admin-non-owner-stranger")

    const rulesUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/rules`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${strangerSession.accessToken}`,
        },
        body: JSON.stringify({
          rules: [{ title: "Hacked", body: "Hacked", report_reason: "Hacked", status: "active" }],
        }),
      },
      ctx.env,
    ))
    expect(rulesUpdate.status).toBe(404)
  })

  test("admin token is ignored when PIRATE_ADMIN_TOKEN is not configured", async () => {
    const ctx = await createRouteTestContext({})
    cleanup = ctx.cleanup

    const ownerSession = await exchangeJwt(ctx.env, "admin-no-config-owner")
    await completeUniqueHumanVerification(ctx.env, ownerSession.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "No Config Club",
membership_mode: "request",
      handle_policy: { policy_template: "standard" },
    }, ctx.env, ownerSession.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    const rulesUpdate = await Promise.resolve(app.request(
      `http://pirate.test/communities/${communityCreateBody.community.id.replace(/^com_/, "")}/rules`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": "any-token",
          "x-admin-as-user-id": ownerSession.userId,
        },
        body: JSON.stringify({
          rules: [{ title: "Test", body: "Test", report_reason: "Test", status: "active" }],
        }),
      },
      ctx.env,
    ))
    expect(rulesUpdate.status).toBe(401)
  })
})
