import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "./helpers"
import { exchangeJwt, requestJson } from "./profiles-test-helpers"

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

    const repairedQuery = await ctx.client.execute({
      sql: `
        SELECT primary_linked_handle_id
        FROM profiles
        WHERE user_id = ?1
        LIMIT 1
      `,
      args: [session.userId],
    })
    expect(repairedQuery.rows).toHaveLength(1)
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

  test("public profile by user id works without auth", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "profile-public-user-id")

    const patched = await requestJson("http://pirate.test/profiles/me", "PATCH", {
      display_name: "Captain Public",
      bio: "Visible while logged out",
      avatar_ref: "ipfs://public-avatar",
      cover_ref: "ipfs://public-cover",
      preferred_locale: "en-US",
    }, ctx.env, session.accessToken)
    expect(patched.status).toBe(200)

    const publicProfile = await app.request(`http://pirate.test/profiles/${session.userId}`, {}, ctx.env)
    expect(publicProfile.status).toBe(200)
    const publicBody = await json(publicProfile) as {
      user_id: string
      display_name: string | null
      cover_ref: string | null
      preferred_locale: string | null
      global_handle: { label: string }
    }
    expect(publicBody.user_id).toBe(session.userId)
    expect(publicBody.display_name).toBe("Captain Public")
    expect(publicBody.cover_ref).toBe("ipfs://public-cover")
    expect(publicBody.preferred_locale).toBe("en-US")
    expect(publicBody.global_handle.label).toMatch(/\.pirate$/)
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

})
