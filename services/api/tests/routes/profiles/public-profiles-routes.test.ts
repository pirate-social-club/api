import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { setEnsResolverForTests } from "../../../src/lib/auth/ens-linked-handle-service"
import { setHostBookableConfigLoaderForTests } from "../../../src/lib/bookings/host-bookable"
import { exchangeJwt, requestJson } from "./profiles-test-helpers"

let cleanup: (() => Promise<void>) | null = null

beforeEach(() => {
  resetRuntimeCaches()
})

afterEach(async () => {
  setHostBookableConfigLoaderForTests(null)
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("public profile routes", () => {
  test("public profiles resolve by active wallet address", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "profile-public-wallet-user")
    const attachedAt = new Date().toISOString()
    const walletAddress = "0x1234567890abcdef1234567890abcdef12345678"

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
          ?1, ?2, 'eip155:1', ?3, ?3, 'test', 'profile-public-wallet-user', 'external', 1, 'active', ?4, NULL, ?4, ?4
        )
      `,
      args: ["wal_public_wallet", session.userId, walletAddress.toLowerCase(), attachedAt],
    })
    await ctx.client.execute({
      sql: `
        UPDATE users
        SET primary_wallet_attachment_id = ?2,
            updated_at = ?3
        WHERE user_id = ?1
      `,
      args: [session.userId, "wal_public_wallet", attachedAt],
    })

    const response = await app.request(`http://pirate.test/public-profiles/by-wallet/${walletAddress}`, {}, ctx.env)
    expect(response.status).toBe(200)
    const body = await json(response) as {
      profile: { id: string; primary_wallet_address: string | null }
      resolved_handle_label: string
    }
    expect(body.profile.id).toBe(session.publicUserId)
    expect(body.profile.primary_wallet_address).toBe(walletAddress.toLowerCase())
    expect(body.resolved_handle_label.endsWith(".pirate")).toBe(true)
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

    const renamed = await requestJson("http://pirate.test/profiles/me/rename-global-handle", "POST", {
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
          created_at,
          updated_at
        ) VALUES
          (?1, ?2, ?3, 'request', 'active', 'active', 'none', NULL, NULL, NULL, NULL, ?4, ?4),
          (?5, ?2, ?6, 'request', 'active', 'active', 'none', NULL, NULL, NULL, NULL, ?7, ?7),
          (?8, ?2, ?9, 'request', 'draft', 'requested', 'none', NULL, NULL, NULL, NULL, ?10, ?10)
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
      profile: { id: string; global_handle: { label: string } }
      created_communities: Array<{ community: string; display_name: string; route_slug: string | null; created: number }>
    }
    expect(canonicalBody.requested_handle_label).toBe("captainpublic.pirate")
    expect(canonicalBody.resolved_handle_label).toBe("captainpublic.pirate")
    expect(canonicalBody.is_canonical).toBe(true)
    expect(canonicalBody.profile.id).toBe(session.publicUserId)
    expect(canonicalBody.profile.global_handle.label).toBe("captainpublic.pirate")
    expect(canonicalBody.created_communities.map((community) => ({
      community: community.community,
      display_name: community.display_name,
    }))).toEqual([
      { community: "com_cmt_public_beta", display_name: "Beta Club" },
      { community: "com_cmt_public_alpha", display_name: "Alpha Club" },
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
      profile: { id: string; global_handle: { label: string } }
    }
    expect(redirectedBody.requested_handle_label).toBe(originalHandle)
    expect(redirectedBody.resolved_handle_label).toBe("captainpublic.pirate")
    expect(redirectedBody.is_canonical).toBe(false)
    expect(redirectedBody.profile.id).toBe(session.publicUserId)
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

    const renamed = await requestJson("http://pirate.test/profiles/me/rename-global-handle", "POST", {
      desired_label: "queryparamcaptain",
    }, ctx.env, session.accessToken)
    expect(renamed.status).toBe(200)

    const response = await app.request("http://pirate.test/public-profiles/queryparamcaptain", {}, ctx.env)
    expect(response.status).toBe(200)
    const body = await json(response) as {
      resolved_handle_label: string
      is_canonical: boolean
      profile: { id: string }
    }
    expect(body.resolved_handle_label).toBe("queryparamcaptain.pirate")
    expect(body.is_canonical).toBe(true)
    expect(body.profile.id).toBe(session.publicUserId)
  })

  test("public profiles resolve bookability with the canonical user id, not the serialized public id", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "profile-public-bookable-host")
    let observedHostUserId: string | null = null
    setHostBookableConfigLoaderForTests(async (_env, hostUserId) => {
      observedHostUserId = hostUserId
      return hostUserId === session.userId
        ? { profile: { isPublished: true }, availabilityRules: [{}] }
        : null
    })

    const renamed = await requestJson("http://pirate.test/profiles/me/rename-global-handle", "POST", {
      desired_label: "bookablecaptain",
    }, ctx.env, session.accessToken)
    expect(renamed.status).toBe(200)

    const response = await app.request("http://pirate.test/public-profiles/bookablecaptain", {}, ctx.env)
    expect(response.status).toBe(200)
    const body = await json(response) as {
      profile: { id: string; is_bookable?: boolean }
      resolved_handle_label: string
    }
    expect(body.resolved_handle_label).toBe("bookablecaptain.pirate")
    expect(body.profile.id).toBe(session.publicUserId)
    expect(observedHostUserId).toBe(session.userId)
    expect(body.profile.is_bookable).toBe(true)
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

    setEnsResolverForTests(async () => ({
      name: "blackbeard.eth",
      metadata: {
        avatar: "https://example.com/blackbeard.png",
        description: "Captain of the Queen Anne's Revenge.",
        header: "ipfs://bafyblackbeard/header.png",
        social: {
          discord: "javascript:alert(1)",
          github: "blackbeard",
          twitter: "@blackbeard",
        },
        url: "https://blackbeard.example",
      },
    }))

    const synced = await requestJson("http://pirate.test/profiles/me/linked-handles/sync", "POST", {}, ctx.env, session.accessToken)
    expect(synced.status).toBe(200)
    const syncedBody = await json(synced) as {
      avatar_ref: string | null
      avatar_source: string | null
      bio: string | null
      bio_source: string | null
      cover_ref: string | null
      cover_source: string | null
      linked_handles: Array<{ linked_handle: string; label: string; kind: string; metadata?: Record<string, unknown> | null; verification_state: string }>
      primary_public_handle: { linked_handle: string; label: string } | null
    }
    expect(syncedBody.primary_public_handle).toBeNull()
    expect(syncedBody.avatar_ref).toBe("https://example.com/blackbeard.png")
    expect(syncedBody.avatar_source).toBe("ens")
    expect(syncedBody.bio).toBe("Captain of the Queen Anne's Revenge.")
    expect(syncedBody.bio_source).toBe("ens")
    expect(syncedBody.cover_ref).toBe("https://ipfs.io/ipfs/bafyblackbeard/header.png")
    expect(syncedBody.cover_source).toBe("ens")
    expect(syncedBody.linked_handles[0]?.label ?? "").toMatch(/^[a-z]+-[a-z]+-\d{4}\.pirate$/)
    expect(syncedBody.linked_handles[1]?.label).toBe("blackbeard.eth")

    const ensHandle = syncedBody.linked_handles.find((handle) => handle.kind === "ens")
    expect(ensHandle?.verification_state).toBe("verified")
    expect(ensHandle?.metadata?.avatar).toBe("https://example.com/blackbeard.png")
    expect((ensHandle?.metadata?.social as Record<string, unknown> | undefined)?.discord).toBe(undefined)
    expect((ensHandle?.metadata?.social as Record<string, unknown> | undefined)?.github).toBe("blackbeard")
    expect((ensHandle?.metadata?.social as Record<string, unknown> | undefined)?.twitter).toBe("blackbeard")

    setEnsResolverForTests(async () => ({
      name: "blackbeard.eth",
      metadata: {
        avatar: "https://example.com/blackbeard-v2.png",
        description: "Captain of the Queen Anne's Revenge, updated.",
        header: "ipfs://bafyblackbeard/header-v2.png",
      },
    }))

    const updatedEnsMedia = await requestJson("http://pirate.test/profiles/me/linked-handles/sync", "POST", {}, ctx.env, session.accessToken)
    expect(updatedEnsMedia.status).toBe(200)
    const updatedEnsMediaBody = await json(updatedEnsMedia) as {
      avatar_ref: string | null
      avatar_source: string | null
      bio: string | null
      bio_source: string | null
      cover_ref: string | null
      cover_source: string | null
    }
    expect(updatedEnsMediaBody.avatar_ref).toBe("https://example.com/blackbeard-v2.png")
    expect(updatedEnsMediaBody.avatar_source).toBe("ens")
    expect(updatedEnsMediaBody.bio).toBe("Captain of the Queen Anne's Revenge, updated.")
    expect(updatedEnsMediaBody.bio_source).toBe("ens")
    expect(updatedEnsMediaBody.cover_ref).toBe("https://ipfs.io/ipfs/bafyblackbeard/header-v2.png")
    expect(updatedEnsMediaBody.cover_source).toBe("ens")

    const removedAvatar = await requestJson("http://pirate.test/profiles/me", "PATCH", {
      avatar_source: "none",
    }, ctx.env, session.accessToken)
    expect(removedAvatar.status).toBe(200)
    const removedAvatarBody = await json(removedAvatar) as { avatar_ref: string | null; avatar_source: string | null }
    expect(removedAvatarBody.avatar_ref).toBeNull()
    expect(removedAvatarBody.avatar_source).toBe("none")

    const resynced = await requestJson("http://pirate.test/profiles/me/linked-handles/sync", "POST", {}, ctx.env, session.accessToken)
    expect(resynced.status).toBe(200)
    const resyncedBody = await json(resynced) as { avatar_ref: string | null; avatar_source: string | null; bio: string | null; bio_source: string | null }
    expect(resyncedBody.avatar_ref).toBeNull()
    expect(resyncedBody.avatar_source).toBe("none")
    expect(resyncedBody.bio).toBe("Captain of the Queen Anne's Revenge, updated.")
    expect(resyncedBody.bio_source).toBe("ens")

    const selected = await requestJson("http://pirate.test/profiles/me/primary-public-handle", "POST", {
      linked_handle_id: ensHandle?.linked_handle ?? null,
    }, ctx.env, session.accessToken)
    expect(selected.status).toBe(200)
    const selectedBody = await json(selected) as {
      primary_public_handle: { linked_handle: string; label: string } | null
      global_handle: { label: string }
    }
    expect(selectedBody.primary_public_handle?.label).toBe("blackbeard.eth")

    const ensProfile = await app.request("http://pirate.test/public-profiles/blackbeard.eth", {}, ctx.env)
    expect(ensProfile.status).toBe(200)
    const ensProfileBody = await json(ensProfile) as {
      requested_handle_label: string
      resolved_handle_label: string
      is_canonical: boolean
      profile: { id: string; primary_public_handle: { label: string } | null; global_handle: { label: string } }
    }
    expect(ensProfileBody.requested_handle_label).toBe("blackbeard.eth")
    expect(ensProfileBody.resolved_handle_label).toBe("blackbeard.eth")
    expect(ensProfileBody.is_canonical).toBe(true)
    expect(ensProfileBody.profile.id).toBe(session.publicUserId)
    expect(ensProfileBody.profile.primary_public_handle?.label).toBe("blackbeard.eth")

    const pirateProfile = await app.request(
      `http://pirate.test/public-profiles/${encodeURIComponent(selectedBody.global_handle.label)}`,
      {},
      ctx.env,
    )
    expect(pirateProfile.status).toBe(200)
    const pirateProfileBody = await json(pirateProfile) as {
      requested_handle_label: string
      resolved_handle_label: string
      is_canonical: boolean
    }
    expect(pirateProfileBody.requested_handle_label).toBe(selectedBody.global_handle.label)
    expect(pirateProfileBody.resolved_handle_label).toBe("blackbeard.eth")
    expect(pirateProfileBody.is_canonical).toBe(false)
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
      linked_handles: Array<{ linked_handle: string; kind: string }>
    }
    const ensHandle = firstSyncBody.linked_handles.find((handle) => handle.kind === "ens")
    expect(typeof ensHandle?.linked_handle).toBe("string")

    const selected = await requestJson("http://pirate.test/profiles/me/primary-public-handle", "POST", {
      linked_handle_id: ensHandle?.linked_handle ?? null,
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
