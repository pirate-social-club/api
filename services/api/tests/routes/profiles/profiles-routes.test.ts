import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../../src/index"
import { setRedditSnapshotImporterForTests, setRedditVerificationCheckerForTests } from "../../../src/lib/onboarding/reddit-bootstrap"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { exchangeJwt, requestJson } from "./profiles-test-helpers"

let cleanup: (() => Promise<void>) | null = null

beforeEach(() => {
  resetRuntimeCaches()
  setRedditVerificationCheckerForTests(null)
  setRedditSnapshotImporterForTests(null)
})

afterEach(async () => {
  setRedditVerificationCheckerForTests(null)
  setRedditSnapshotImporterForTests(null)
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

async function verifyAndImportReddit(input: {
  env: Parameters<typeof requestJson>[3]
  accessToken: string
  redditUsername: string
}): Promise<void> {
  const createdVerification = await requestJson("http://pirate.test/onboarding/reddit-verification", "POST", {
    reddit_username: input.redditUsername,
  }, input.env, input.accessToken)
  expect(createdVerification.status).toBe(200)

  const verified = await requestJson("http://pirate.test/onboarding/reddit-verification", "POST", {
    reddit_username: input.redditUsername,
  }, input.env, input.accessToken)
  expect(verified.status).toBe(200)

  const imported = await requestJson("http://pirate.test/onboarding/reddit-imports", "POST", {
    reddit_username: input.redditUsername,
  }, input.env, input.accessToken)
  expect(imported.status).toBe(202)
}

describe("profile routes", () => {
  test("profiles can publish and rotate XMTP inbox ids", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "profile-xmtp-user")

    const published = await requestJson("http://pirate.test/profiles/me/xmtp-inbox", "POST", {
      xmtp_inbox_id: "xmtp-inbox-profile-route-1",
    }, ctx.env, session.accessToken)
    expect(published.status).toBe(200)
    const publishedBody = await json(published) as { xmtp_inbox_id: string | null }
    expect(publishedBody.xmtp_inbox_id).toBe("xmtp-inbox-profile-route-1")

    const rotated = await requestJson("http://pirate.test/profiles/me/xmtp-inbox", "POST", {
      xmtp_inbox_id: "xmtp-inbox-profile-route-2",
    }, ctx.env, session.accessToken)
    expect(rotated.status).toBe(200)
    const rotatedBody = await json(rotated) as { xmtp_inbox_id: string | null }
    expect(rotatedBody.xmtp_inbox_id).toBe("xmtp-inbox-profile-route-2")

    const invalid = await requestJson("http://pirate.test/profiles/me/xmtp-inbox", "POST", {
      xmtp_inbox_id: "bad value with spaces",
    }, ctx.env, session.accessToken)
    expect(invalid.status).toBe(400)
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
      display_verified_nationality_badge: true,
    }, ctx.env, session.accessToken)
    expect(patched.status).toBe(200)
    const patchedBody = await json(patched) as {
      display_name: string | null
      bio: string | null
      avatar_ref: string | null
      cover_ref: string | null
      preferred_locale: string | null
      display_verified_nationality_badge: boolean | null
      nationality_badge_country: string | null
    }
    expect(patchedBody.display_name).toBe("Techno Hippie")
    expect(patchedBody.bio).toBe("Imported from elsewhere")
    expect(patchedBody.avatar_ref).toBe("ipfs://avatar-ref")
    expect(patchedBody.cover_ref).toBe("ipfs://cover-ref")
    expect(patchedBody.preferred_locale).toBe("en-US")
    expect(patchedBody.display_verified_nationality_badge).toBe(true)
    expect(patchedBody.nationality_badge_country).toBeNull()

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
      display_verified_nationality_badge: boolean | null
      nationality_badge_country: string | null
    }
    expect(publicBody.user_id).toBe(session.userId)
    expect(publicBody.display_name).toBe("Techno Hippie")
    expect(publicBody.cover_ref).toBe("ipfs://cover-ref")
    expect(publicBody.preferred_locale).toBe("en-US")
    expect(publicBody.display_verified_nationality_badge).toBe(true)
    expect(publicBody.nationality_badge_country).toBeNull()
  })

  test("nationality badge country is exposed only after opt-in and verified Self nationality", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "profile-nationality-badge-user")

    await ctx.client.execute({
      sql: `
        UPDATE users
        SET verification_capabilities_json = ?2
        WHERE user_id = ?1
      `,
      args: [session.userId, JSON.stringify({
        unique_human: { state: "unverified", provider: null, mechanism: null, verified_at: null },
        age_over_18: { state: "unverified", provider: null, proof_type: null, mechanism: null, verified_at: null },
        minimum_age: { state: "unverified", provider: null, proof_type: null, value: null, mechanism: null, verified_at: null },
        nationality: { state: "verified", provider: "self", proof_type: "nationality", value: "USA", mechanism: null, verified_at: "2026-04-24T00:00:00.000Z" },
        gender: { state: "unverified", provider: null, proof_type: null, value: null, mechanism: null, verified_at: null },
        wallet_score: { state: "unverified", provider: null, mechanism: null, verified_at: null },
      })],
    })

    const off = await app.request(`http://pirate.test/profiles/${session.userId}`, {}, ctx.env)
    expect(off.status).toBe(200)
    const offBody = await json(off) as { nationality_badge_country: string | null }
    expect(offBody.nationality_badge_country).toBeNull()

    const patched = await requestJson("http://pirate.test/profiles/me", "PATCH", {
      display_verified_nationality_badge: true,
    }, ctx.env, session.accessToken)
    expect(patched.status).toBe(200)
    const patchedBody = await json(patched) as {
      display_verified_nationality_badge: boolean | null
      nationality_badge_country: string | null
    }
    expect(patchedBody.display_verified_nationality_badge).toBe(true)
    expect(patchedBody.nationality_badge_country).toBe("US")

    const publicProfile = await app.request(`http://pirate.test/profiles/${session.userId}`, {}, ctx.env)
    expect(publicProfile.status).toBe(200)
    const publicBody = await json(publicProfile) as { nationality_badge_country: string | null }
    expect(publicBody.nationality_badge_country).toBe("US")
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
    const ctx = await createRouteTestContext({
      ANALYTICS_ENABLED: "true",
      ANALYTICS_HMAC_SECRET: "analytics-secret",
    })
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

    const analytics = await ctx.client.execute({
      sql: `
        SELECT properties_json
        FROM analytics_outbox
        WHERE event_name = 'handle_claim_succeeded'
        ORDER BY created_at DESC
        LIMIT 1
      `,
    })
    const analyticsProperties = JSON.parse(String(analytics.rows[0]?.properties_json ?? "{}")) as {
      source?: string
      tier?: string
      handle_length?: number
    }
    expect(analyticsProperties.source).toBe("free_cleanup_rename")
    expect(analyticsProperties.tier).toBe("standard")
    expect(analyticsProperties.handle_length).toBe(12)
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

  test("reddit claim can issue a shorter verified username handle without using the cleanup rename path", async () => {
    const ctx = await createRouteTestContext({
      ANALYTICS_ENABLED: "true",
      ANALYTICS_HMAC_SECRET: "analytics-secret",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "profile-reddit-claim-user")
    const createdVerification = await requestJson("http://pirate.test/onboarding/reddit-verification", "POST", {
      reddit_username: "captain",
    }, ctx.env, session.accessToken)
    expect(createdVerification.status).toBe(200)

    setRedditVerificationCheckerForTests(async () => ({ status: "verified" }))
    const verified = await requestJson("http://pirate.test/onboarding/reddit-verification", "POST", {
      reddit_username: "captain",
    }, ctx.env, session.accessToken)
    expect(verified.status).toBe(200)

    setRedditSnapshotImporterForTests(async ({ redditUsername }) => ({
      reddit_username: redditUsername,
      imported_at: 1777024800,
      account_age_days: 900,
      imported_reddit_score: 12_000,
      top_subreddits: [
        {
          subreddit: "pirate",
          karma: 12_000,
          posts: 10,
          rank_source: "karma",
        },
      ],
      moderator_of: [],
      inferred_interests: [],
      suggested_communities: [],
      coverage_note: "Historical archival snapshot.",
    }))
    const imported = await requestJson("http://pirate.test/onboarding/reddit-imports", "POST", {
      reddit_username: "captain",
    }, ctx.env, session.accessToken)
    expect(imported.status).toBe(202)

    const quote = await requestJson("http://pirate.test/profiles/me/global-handle/upgrade-quote", "POST", {
      desired_label: "captain",
    }, ctx.env, session.accessToken)
    expect(quote.status).toBe(200)
    const quoteBody = await json(quote) as {
      desired_label: string
      tier: string
      price_usd: number
      eligible: boolean
      benefit_source: string | null
      reputation_discount_usd: number | null
    }
    expect(quoteBody.desired_label).toBe("captain.pirate")
    expect(quoteBody.tier).toBe("premium")
    expect(quoteBody.price_usd).toBe(0)
    expect(quoteBody.eligible).toBe(true)
    expect(quoteBody.benefit_source).toBe("verified_reddit_username")
    expect(quoteBody.reputation_discount_usd).toBe(250)

    const claimed = await requestJson("http://pirate.test/profiles/me/global-handle/reddit-claim", "POST", {
      desired_label: "captain",
    }, ctx.env, session.accessToken)
    expect(claimed.status).toBe(200)
    const claimedBody = await json(claimed) as {
      label: string
      tier: string
      issuance_source: string
      free_rename_consumed: boolean
    }
    expect(claimedBody.label).toBe("captain.pirate")
    expect(claimedBody.tier).toBe("premium")
    expect(claimedBody.issuance_source).toBe("reddit_verified_claim")
    expect(claimedBody.free_rename_consumed).toBe(true)

    const analytics = await ctx.client.execute({
      sql: `
        SELECT properties_json
        FROM analytics_outbox
        WHERE event_name = 'handle_claim_succeeded'
        ORDER BY created_at DESC
        LIMIT 1
      `,
    })
    const analyticsProperties = JSON.parse(String(analytics.rows[0]?.properties_json ?? "{}")) as {
      source?: string
      tier?: string
      handle_length?: number
      shorter_by?: number
    }
    expect(analyticsProperties.source).toBe("verified_reddit_username")
    expect(analyticsProperties.tier).toBe("premium")
    expect(analyticsProperties.handle_length).toBe(7)
    expect(analyticsProperties.shorter_by).toBe(1)
  })

  test("reddit claim cannot be reused to upgrade another profile", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    setRedditVerificationCheckerForTests(async () => ({ status: "verified" }))
    setRedditSnapshotImporterForTests(async ({ redditUsername }) => ({
      reddit_username: redditUsername,
      imported_at: 1777024800,
      account_age_days: 900,
      imported_reddit_score: 12_000,
      top_subreddits: [],
      moderator_of: [],
      inferred_interests: [],
      suggested_communities: [],
      coverage_note: "Historical archival snapshot.",
    }))

    const firstSession = await exchangeJwt(ctx.env, "profile-reddit-claim-first-user")
    await verifyAndImportReddit({
      env: ctx.env,
      accessToken: firstSession.accessToken,
      redditUsername: "captain",
    })

    const secondSession = await exchangeJwt(ctx.env, "profile-reddit-claim-second-user")
    await verifyAndImportReddit({
      env: ctx.env,
      accessToken: secondSession.accessToken,
      redditUsername: "captain",
    })

    const firstClaim = await requestJson("http://pirate.test/profiles/me/global-handle/reddit-claim", "POST", {
      desired_label: "captain",
    }, ctx.env, firstSession.accessToken)
    expect(firstClaim.status).toBe(200)

    const secondQuote = await requestJson("http://pirate.test/profiles/me/global-handle/upgrade-quote", "POST", {
      desired_label: "captain",
    }, ctx.env, secondSession.accessToken)
    expect(secondQuote.status).toBe(200)
    const secondQuoteBody = await json(secondQuote) as {
      eligible: boolean
      reason: string | null
    }
    expect(secondQuoteBody.eligible).toBe(false)
    expect(secondQuoteBody.reason).toBe("This Reddit account has already been used for a Pirate handle")

    const secondClaim = await requestJson("http://pirate.test/profiles/me/global-handle/reddit-claim", "POST", {
      desired_label: "captain",
    }, ctx.env, secondSession.accessToken)
    expect(secondClaim.status).toBe(403)
    const secondClaimBody = await json(secondClaim) as { code: string; message: string }
    expect(secondClaimBody.code).toBe("eligibility_failed")
    expect(secondClaimBody.message).toBe("This Reddit account has already been used for a Pirate handle")

    const thirdSession = await exchangeJwt(ctx.env, "profile-reddit-claim-third-user")
    const blockedVerification = await requestJson("http://pirate.test/onboarding/reddit-verification", "POST", {
      reddit_username: "captain",
    }, ctx.env, thirdSession.accessToken)
    expect(blockedVerification.status).toBe(409)
    const blockedVerificationBody = await json(blockedVerification) as { code: string; message: string }
    expect(blockedVerificationBody.code).toBe("conflict")
    expect(blockedVerificationBody.message).toBe("This Reddit account has already been used for a Pirate handle")
  })

  test("profile cannot spend multiple reddit handle claims", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    setRedditVerificationCheckerForTests(async () => ({ status: "verified" }))
    setRedditSnapshotImporterForTests(async ({ redditUsername }) => ({
      reddit_username: redditUsername,
      imported_at: 1777024800,
      account_age_days: 900,
      imported_reddit_score: 100_000,
      top_subreddits: [],
      moderator_of: [],
      inferred_interests: [],
      suggested_communities: [],
      coverage_note: "Historical archival snapshot.",
    }))

    const session = await exchangeJwt(ctx.env, "profile-reddit-claim-single-use-user")
    await verifyAndImportReddit({
      env: ctx.env,
      accessToken: session.accessToken,
      redditUsername: "captain",
    })

    const firstClaim = await requestJson("http://pirate.test/profiles/me/global-handle/reddit-claim", "POST", {
      desired_label: "captain",
    }, ctx.env, session.accessToken)
    expect(firstClaim.status).toBe(200)

    await verifyAndImportReddit({
      env: ctx.env,
      accessToken: session.accessToken,
      redditUsername: "blackbeard",
    })

    const secondQuote = await requestJson("http://pirate.test/profiles/me/global-handle/upgrade-quote", "POST", {
      desired_label: "blackbeard",
    }, ctx.env, session.accessToken)
    expect(secondQuote.status).toBe(200)
    const secondQuoteBody = await json(secondQuote) as {
      eligible: boolean
      reason: string | null
    }
    expect(secondQuoteBody.eligible).toBe(false)
    expect(secondQuoteBody.reason).toBe("A Reddit account has already been used for this profile")

    const secondClaim = await requestJson("http://pirate.test/profiles/me/global-handle/reddit-claim", "POST", {
      desired_label: "blackbeard",
    }, ctx.env, session.accessToken)
    expect(secondClaim.status).toBe(403)
    const secondClaimBody = await json(secondClaim) as { code: string; message: string }
    expect(secondClaimBody.code).toBe("eligibility_failed")
    expect(secondClaimBody.message).toBe("A Reddit account has already been used for this profile")
  })

})
