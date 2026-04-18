import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../src/index"
import { createRouteTestContext, json, mintUpstreamJwt, resetRuntimeCaches } from "./helpers"
import { setEnsResolverForTests } from "../src/lib/auth/ens-linked-handle-service"
import type { Env } from "../src/types"

let cleanup: (() => Promise<void>) | null = null

function requestJson(url: string, method: "POST" | "PATCH", body: unknown, env: Env, token?: string): Promise<Response> {
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

async function exchangeJwt(env: Env, sub: string): Promise<{ accessToken: string; userId: string }> {
  const jwt = await mintUpstreamJwt(env, { sub })
  const response = await requestJson("http://pirate.test/auth/session/exchange", "POST", {
    proof: {
      type: "jwt_based_auth",
      jwt,
    },
  }, env)
  const body = await json(response) as { access_token: string; user: { user_id: string } }
  return {
    accessToken: body.access_token,
    userId: body.user.user_id,
  }
}

beforeEach(() => {
  resetRuntimeCaches()
})

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("profile routes", () => {
  test("profiles patch self-heals legacy sqlite databases missing primary_linked_handle_id", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "profile-legacy-column-user")

    await ctx.client.execute("PRAGMA foreign_keys = OFF")
    await ctx.client.execute("ALTER TABLE profiles RENAME TO profiles_legacy_backup")
    await ctx.client.execute(`
      CREATE TABLE profiles (
        user_id TEXT PRIMARY KEY,
        display_name TEXT,
        bio TEXT,
        avatar_ref TEXT,
        cover_ref TEXT,
        global_handle_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        preferred_locale TEXT,
        FOREIGN KEY (user_id) REFERENCES users(user_id),
        FOREIGN KEY (global_handle_id) REFERENCES global_handles(global_handle_id)
      )
    `)
    await ctx.client.execute(`
      INSERT INTO profiles (
        user_id,
        display_name,
        bio,
        avatar_ref,
        cover_ref,
        global_handle_id,
        created_at,
        updated_at,
        preferred_locale
      )
      SELECT
        user_id,
        display_name,
        bio,
        avatar_ref,
        cover_ref,
        global_handle_id,
        created_at,
        updated_at,
        preferred_locale
      FROM profiles_legacy_backup
    `)
    await ctx.client.execute("DROP TABLE profiles_legacy_backup")
    await ctx.client.execute("PRAGMA foreign_keys = ON")

    const patched = await requestJson("http://pirate.test/profiles/me", "PATCH", {
      avatar_ref: "ipfs://legacy-avatar-ref",
      cover_ref: "ipfs://legacy-cover-ref",
    }, ctx.env, session.accessToken)
    expect(patched.status).toBe(200)
    const patchedBody = await json(patched) as {
      avatar_ref: string | null
      cover_ref: string | null
    }
    expect(patchedBody.avatar_ref).toBe("ipfs://legacy-avatar-ref")
    expect(patchedBody.cover_ref).toBe("ipfs://legacy-cover-ref")

    const columns = await ctx.client.execute("PRAGMA table_info(profiles)")
    expect(columns.rows.some((row) => String((row as { name?: unknown }).name) === "primary_linked_handle_id")).toBe(true)
  })

  test("profiles/me, patch, and public profile read work through the full route stack", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "profile-user")

    const me = await app.request("http://pirate.test/profiles/me", {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
      },
    }, ctx.env)
    expect(me.status).toBe(200)
    const meBody = await json(me) as {
      user_id: string
      display_name: string | null
      preferred_locale: string | null
      global_handle: { label: string }
    }
    expect(meBody.user_id).toBe(session.userId)
    expect(meBody.display_name).toBeNull()
    expect(meBody.preferred_locale).toBeNull()
    expect(meBody.global_handle.label).toMatch(/^[a-z]+-[a-z]+-\d{4}\.pirate$/)

    const patched = await requestJson("http://pirate.test/profiles/me", "PATCH", {
      display_name: "Techno Hippie",
      bio: "Imported from elsewhere",
      avatar_ref: "ipfs://avatar-ref",
      cover_ref: "ipfs://cover-ref",
      preferred_locale: "en-US",
    }, ctx.env, session.accessToken)
    expect(patched.status).toBe(200)
    const patchedBody = await json(patched) as {
      display_name: string | null
      bio: string | null
      avatar_ref: string | null
      cover_ref: string | null
      preferred_locale: string | null
    }
    expect(patchedBody.display_name).toBe("Techno Hippie")
    expect(patchedBody.bio).toBe("Imported from elsewhere")
    expect(patchedBody.avatar_ref).toBe("ipfs://avatar-ref")
    expect(patchedBody.cover_ref).toBe("ipfs://cover-ref")
    expect(patchedBody.preferred_locale).toBe("en-US")

    const publicProfile = await app.request(`http://pirate.test/profiles/${session.userId}`, {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
      },
    }, ctx.env)
    expect(publicProfile.status).toBe(200)
    const publicBody = await json(publicProfile) as {
      user_id: string
      display_name: string | null
      cover_ref: string | null
      preferred_locale: string | null
    }
    expect(publicBody.user_id).toBe(session.userId)
    expect(publicBody.display_name).toBe("Techno Hippie")
    expect(publicBody.cover_ref).toBe("ipfs://cover-ref")
    expect(publicBody.preferred_locale).toBe("en-US")
  })

  test("free cleanup rename updates the active global handle and consumes rename availability", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "profile-rename-user")

    const renamed = await requestJson("http://pirate.test/profiles/me/global-handle/rename", "POST", {
      desired_label: "technohippie",
    }, ctx.env, session.accessToken)
    expect(renamed.status).toBe(200)
    const renamedBody = await json(renamed) as {
      label: string
      tier: string
      issuance_source: string
      free_rename_consumed: boolean
    }
    expect(renamedBody.label).toBe("technohippie.pirate")
    expect(renamedBody.tier).toBe("standard")
    expect(renamedBody.issuance_source).toBe("free_cleanup_rename")
    expect(renamedBody.free_rename_consumed).toBe(true)

    const me = await app.request("http://pirate.test/profiles/me", {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
      },
    }, ctx.env)
    expect(me.status).toBe(200)
    const meBody = await json(me) as {
      global_handle: { label: string; free_rename_consumed: boolean }
    }
    expect(meBody.global_handle.label).toBe("technohippie.pirate")
    expect(meBody.global_handle.free_rename_consumed).toBe(true)

    const onboarding = await app.request("http://pirate.test/onboarding/status", {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
      },
    }, ctx.env)
    expect(onboarding.status).toBe(200)
    const onboardingBody = await json(onboarding) as { cleanup_rename_available: boolean }
    expect(onboardingBody.cleanup_rename_available).toBe(false)
  })

  test("public profiles resolve canonical and redirected pirate handles without auth", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "profile-public-handle-user")

    const me = await app.request("http://pirate.test/profiles/me", {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
      },
    }, ctx.env)
    expect(me.status).toBe(200)
    const meBody = await json(me) as {
      global_handle: { label: string }
    }
    const originalHandle = meBody.global_handle.label

    const renamed = await requestJson("http://pirate.test/profiles/me/global-handle/rename", "POST", {
      desired_label: "captainpublic",
    }, ctx.env, session.accessToken)
    expect(renamed.status).toBe(200)

    await ctx.client.execute({
      sql: `
        INSERT INTO communities (
          community_id,
          creator_user_id,
          display_name,
          membership_mode,
          status,
          provisioning_state,
          transfer_state,
          route_slug,
          namespace_verification_id,
          pending_namespace_verification_session_id,
          primary_database_binding_id,
          registry_publication_state,
          registry_attempt_id,
          registry_published_at,
          registry_publication_job_id,
          registry_error_code,
          created_at,
          updated_at
        ) VALUES
          (?1, ?2, ?3, 'open', 'active', 'active', 'none', NULL, NULL, NULL, NULL, 'not_started', NULL, NULL, NULL, NULL, ?4, ?4),
          (?5, ?2, ?6, 'open', 'active', 'active', 'none', NULL, NULL, NULL, NULL, 'not_started', NULL, NULL, NULL, NULL, ?7, ?7),
          (?8, ?2, ?9, 'open', 'draft', 'requested', 'none', NULL, NULL, NULL, NULL, 'not_started', NULL, NULL, NULL, NULL, ?10, ?10)
      `,
      args: [
        "cmt_public_alpha",
        session.userId,
        "Alpha Club",
        "2026-04-17T00:00:00.000Z",
        "cmt_public_beta",
        "Beta Club",
        "2026-04-18T00:00:00.000Z",
        "cmt_public_hidden",
        "Hidden Club",
        "2026-04-19T00:00:00.000Z",
      ],
    })

    const canonicalProfile = await app.request("http://pirate.test/public-profiles/captainpublic", {}, ctx.env)
    expect(canonicalProfile.status).toBe(200)
    const canonicalBody = await json(canonicalProfile) as {
      requested_handle_label: string
      resolved_handle_label: string
      is_canonical: boolean
      profile: { user_id: string; global_handle: { label: string } }
      created_communities: Array<{ community_id: string; display_name: string; route_slug: string | null; created_at: string }>
    }
    expect(canonicalBody.requested_handle_label).toBe("captainpublic.pirate")
    expect(canonicalBody.resolved_handle_label).toBe("captainpublic.pirate")
    expect(canonicalBody.is_canonical).toBe(true)
    expect(canonicalBody.profile.user_id).toBe(session.userId)
    expect(canonicalBody.profile.global_handle.label).toBe("captainpublic.pirate")
    expect(canonicalBody.created_communities.map((community) => ({
      community_id: community.community_id,
      display_name: community.display_name,
    }))).toEqual([
      { community_id: "cmt_public_beta", display_name: "Beta Club" },
      { community_id: "cmt_public_alpha", display_name: "Alpha Club" },
    ])

    const redirectedProfile = await app.request(
      `http://pirate.test/public-profiles/${encodeURIComponent(originalHandle.replace(/\.pirate$/u, ""))}`,
      {},
      ctx.env,
    )
    expect(redirectedProfile.status).toBe(200)
    const redirectedBody = await json(redirectedProfile) as {
      requested_handle_label: string
      resolved_handle_label: string
      is_canonical: boolean
      profile: { user_id: string; global_handle: { label: string } }
    }
    expect(redirectedBody.requested_handle_label).toBe(originalHandle)
    expect(redirectedBody.resolved_handle_label).toBe("captainpublic.pirate")
    expect(redirectedBody.is_canonical).toBe(false)
    expect(redirectedBody.profile.user_id).toBe(session.userId)
    expect(redirectedBody.profile.global_handle.label).toBe("captainpublic.pirate")
  })

  test("public profiles tolerate control-plane URLs with unsupported libsql query params", async () => {
    const base = await createRouteTestContext()
    cleanup = base.cleanup

    const ctx = {
      ...base,
      env: {
        ...base.env,
        CONTROL_PLANE_DATABASE_URL:
          `${base.env.CONTROL_PLANE_DATABASE_URL}?channel_binding=require&sslmode=require`,
      },
    }

    const session = await exchangeJwt(ctx.env, "profile-public-handle-query-param-user")

    const renamed = await requestJson("http://pirate.test/profiles/me/global-handle/rename", "POST", {
      desired_label: "queryparamcaptain",
    }, ctx.env, session.accessToken)
    expect(renamed.status).toBe(200)

    const response = await app.request("http://pirate.test/public-profiles/queryparamcaptain", {}, ctx.env)
    expect(response.status).toBe(200)
    const body = await json(response) as {
      resolved_handle_label: string
      is_canonical: boolean
      profile: { user_id: string }
    }
    expect(body.resolved_handle_label).toBe("queryparamcaptain.pirate")
    expect(body.is_canonical).toBe(true)
    expect(body.profile.user_id).toBe(session.userId)
  })

  test("global handle rename returns conflict when the desired label is already active", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const first = await exchangeJwt(ctx.env, "profile-rename-first")
    const second = await exchangeJwt(ctx.env, "profile-rename-second")

    const firstRename = await requestJson("http://pirate.test/profiles/me/global-handle/rename", "POST", {
      desired_label: "takenhandle",
    }, ctx.env, first.accessToken)
    expect(firstRename.status).toBe(200)

    const secondRename = await requestJson("http://pirate.test/profiles/me/global-handle/rename", "POST", {
      desired_label: "takenhandle",
    }, ctx.env, second.accessToken)
    expect(secondRename.status).toBe(409)
    const secondRenameBody = await json(secondRename) as { code: string; message: string }
    expect(secondRenameBody.code).toBe("conflict")
    expect(secondRenameBody.message).toBe("Desired label is unavailable")
  })

  test("global handle upgrade quote distinguishes free standard cleanup and paid premium handles", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "profile-quote-user")

    const freeQuote = await requestJson("http://pirate.test/profiles/me/global-handle/upgrade-quote", "POST", {
      desired_label: "cleanhandle",
    }, ctx.env, session.accessToken)
    expect(freeQuote.status).toBe(200)
    const freeQuoteBody = await json(freeQuote) as {
      desired_label: string
      tier: string
      price_usd: number
      eligible: boolean
      reason: string | null
    }
    expect(freeQuoteBody.desired_label).toBe("cleanhandle.pirate")
    expect(freeQuoteBody.tier).toBe("standard")
    expect(freeQuoteBody.price_usd).toBe(0)
    expect(freeQuoteBody.eligible).toBe(true)
    expect(freeQuoteBody.reason).toBe("Eligible for free cleanup rename")

    const premiumQuote = await requestJson("http://pirate.test/profiles/me/global-handle/upgrade-quote", "POST", {
      desired_label: "captain",
    }, ctx.env, session.accessToken)
    expect(premiumQuote.status).toBe(200)
    const premiumQuoteBody = await json(premiumQuote) as {
      desired_label: string
      tier: string
      price_usd: number
      eligible: boolean
      reason?: string | null
    }
    expect(premiumQuoteBody.desired_label).toBe("captain.pirate")
    expect(premiumQuoteBody.tier).toBe("premium")
    expect(premiumQuoteBody.price_usd).toBe(250)
    expect(premiumQuoteBody.eligible).toBe(true)
    expect(premiumQuoteBody.reason ?? null).toBeNull()
  })

  test("linked handle sync discovers ENS names and primary public handle can switch to ENS", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "profile-ens-user")
    const attachedAt = new Date().toISOString()

    await ctx.client.execute({
      sql: `
        INSERT INTO wallet_attachments (
          wallet_attachment_id,
          user_id,
          chain_namespace,
          wallet_address_normalized,
          wallet_address_display,
          source_provider,
          source_subject,
          attachment_kind,
          is_primary,
          status,
          attached_at,
          detached_at,
          created_at,
          updated_at
        ) VALUES (
          ?1, ?2, 'eip155:1', ?3, ?3, 'test', 'profile-ens-user', 'external', 1, 'active', ?4, NULL, ?4, ?4
        )
      `,
      args: ["wal_ens_primary", session.userId, "0x42a5f77f2d06c9a7e304817b3c177b91e0c2f3a8", attachedAt],
    })
    await ctx.client.execute({
      sql: `
        UPDATE users
        SET primary_wallet_attachment_id = ?2,
            updated_at = ?3
        WHERE user_id = ?1
      `,
      args: [session.userId, "wal_ens_primary", attachedAt],
    })

    setEnsResolverForTests(async () => "blackbeard.eth")

    const synced = await requestJson("http://pirate.test/profiles/me/linked-handles/sync", "POST", {}, ctx.env, session.accessToken)
    expect(synced.status).toBe(200)
    const syncedBody = await json(synced) as {
      linked_handles: Array<{ linked_handle_id: string; label: string; kind: string; verification_state: string }>
      primary_public_handle: { linked_handle_id: string; label: string } | null
    }
    expect(syncedBody.primary_public_handle).toBeNull()
    expect(syncedBody.linked_handles[0]?.label ?? "").toMatch(/^[a-z]+-[a-z]+-\d{4}\.pirate$/)
    expect(syncedBody.linked_handles[1]?.label).toBe("blackbeard.eth")

    const ensHandle = syncedBody.linked_handles.find((handle) => handle.kind === "ens")
    expect(ensHandle?.verification_state).toBe("verified")

    const selected = await requestJson("http://pirate.test/profiles/me/primary-public-handle", "POST", {
      linked_handle_id: ensHandle?.linked_handle_id ?? null,
    }, ctx.env, session.accessToken)
    expect(selected.status).toBe(200)
    const selectedBody = await json(selected) as {
      primary_public_handle: { linked_handle_id: string; label: string } | null
    }
    expect(selectedBody.primary_public_handle?.label).toBe("blackbeard.eth")
  })

  test("linked handle sync marks stale ENS handles and clears stale primary selection", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "profile-ens-stale-user")
    const attachedAt = new Date().toISOString()

    await ctx.client.execute({
      sql: `
        INSERT INTO wallet_attachments (
          wallet_attachment_id,
          user_id,
          chain_namespace,
          wallet_address_normalized,
          wallet_address_display,
          source_provider,
          source_subject,
          attachment_kind,
          is_primary,
          status,
          attached_at,
          detached_at,
          created_at,
          updated_at
        ) VALUES (
          ?1, ?2, 'eip155:1', ?3, ?3, 'test', 'profile-ens-stale-user', 'external', 1, 'active', ?4, NULL, ?4, ?4
        )
      `,
      args: ["wal_ens_stale", session.userId, "0x11f4845ef4bb010f8aebf2772836e2d33f5e4cc1", attachedAt],
    })
    await ctx.client.execute({
      sql: `
        UPDATE users
        SET primary_wallet_attachment_id = ?2,
            updated_at = ?3
        WHERE user_id = ?1
      `,
      args: [session.userId, "wal_ens_stale", attachedAt],
    })

    setEnsResolverForTests(async () => "stalehandle.eth")
    const firstSync = await requestJson("http://pirate.test/profiles/me/linked-handles/sync", "POST", {}, ctx.env, session.accessToken)
    const firstSyncBody = await json(firstSync) as {
      linked_handles: Array<{ linked_handle_id: string; kind: string }>
    }
    const ensHandle = firstSyncBody.linked_handles.find((handle) => handle.kind === "ens")
    expect(typeof ensHandle?.linked_handle_id).toBe("string")

    const selected = await requestJson("http://pirate.test/profiles/me/primary-public-handle", "POST", {
      linked_handle_id: ensHandle?.linked_handle_id ?? null,
    }, ctx.env, session.accessToken)
    expect(selected.status).toBe(200)

    setEnsResolverForTests(async () => null)
    const secondSync = await requestJson("http://pirate.test/profiles/me/linked-handles/sync", "POST", {}, ctx.env, session.accessToken)
    expect(secondSync.status).toBe(200)
    const secondSyncBody = await json(secondSync) as {
      linked_handles: Array<{ label: string; kind: string; verification_state: string }>
      primary_public_handle: { label: string } | null
    }
    const staleEnsHandle = secondSyncBody.linked_handles.find((handle) => handle.kind === "ens")
    expect(staleEnsHandle?.label).toBe("stalehandle.eth")
    expect(staleEnsHandle?.verification_state).toBe("stale")
    expect(secondSyncBody.primary_public_handle).toBeNull()
  })
})
