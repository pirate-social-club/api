import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../src/index"
import { setRedditVerificationCheckerForTests } from "../src/lib/onboarding/reddit-bootstrap"
import { createRouteTestContext, json, mintUpstreamJwt, resetRuntimeCaches } from "./helpers"
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
  setRedditVerificationCheckerForTests(null)
})

afterEach(async () => {
  setRedditVerificationCheckerForTests(null)
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("profile routes", () => {
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
      preferred_locale: "en-US",
    }, ctx.env, session.accessToken)
    expect(patched.status).toBe(200)
    const patchedBody = await json(patched) as {
      display_name: string | null
      bio: string | null
      avatar_ref: string | null
      preferred_locale: string | null
    }
    expect(patchedBody.display_name).toBe("Techno Hippie")
    expect(patchedBody.bio).toBe("Imported from elsewhere")
    expect(patchedBody.avatar_ref).toBe("ipfs://avatar-ref")
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
      preferred_locale: string | null
    }
    expect(publicBody.user_id).toBe(session.userId)
    expect(publicBody.display_name).toBe("Techno Hippie")
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

  test("second rename attempt after free cleanup is consumed returns 403", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "profile-second-rename-user")

    const firstRename = await requestJson("http://pirate.test/profiles/me/global-handle/rename", "POST", {
      desired_label: "firstchoice",
    }, ctx.env, session.accessToken)
    expect(firstRename.status).toBe(200)

    const secondRename = await requestJson("http://pirate.test/profiles/me/global-handle/rename", "POST", {
      desired_label: "secondchoice",
    }, ctx.env, session.accessToken)
    expect(secondRename.status).toBe(403)
  })

  test("onboarding rename sets username_step_completed and updates issuance_source", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "profile-username-step-user")

    const createdVerification = await requestJson("http://pirate.test/onboarding/reddit-verification", "POST", {
      reddit_username: "u/mynewhandle",
    }, ctx.env, session.accessToken)
    expect(createdVerification.status).toBe(200)
    const createdVerificationBody = await json(createdVerification) as {
      verification_hint: string | null
    }
    const rawCode = createdVerificationBody.verification_hint?.match(/`([^`]+)`/)?.[1] ?? null
    expect(typeof rawCode).toBe("string")

    setRedditVerificationCheckerForTests(async ({ verificationCode }) => verificationCode === rawCode
      ? { status: "verified" as const }
      : { status: "pending" as const, failureCode: "code_not_found" as const })

    const verifiedVerification = await requestJson("http://pirate.test/onboarding/reddit-verification", "POST", {
      reddit_username: "mynewhandle",
    }, ctx.env, session.accessToken)
    expect(verifiedVerification.status).toBe(200)
    const verifiedVerificationBody = await json(verifiedVerification) as {
      status: string
    }
    expect(verifiedVerificationBody.status).toBe("verified")

    const onboardingBefore = await app.request("http://pirate.test/onboarding/status", {
      headers: { authorization: `Bearer ${session.accessToken}` },
    }, ctx.env)
    const onboardingBeforeBody = await json(onboardingBefore) as {
      generated_handle_assigned: boolean
      cleanup_rename_available: boolean
    }
    expect(onboardingBeforeBody.generated_handle_assigned).toBe(true)
    expect(onboardingBeforeBody.cleanup_rename_available).toBe(true)

    const renamed = await requestJson("http://pirate.test/profiles/me/global-handle/rename", "POST", {
      desired_label: "mynewhandle",
    }, ctx.env, session.accessToken)
    expect(renamed.status).toBe(200)
    const renamedBody = await json(renamed) as {
      label: string
      issuance_source: string
      free_rename_consumed: boolean
    }
    expect(renamedBody.label).toBe("mynewhandle.pirate")
    expect(renamedBody.issuance_source).toBe("reddit_verified_claim")
    expect(renamedBody.free_rename_consumed).toBe(true)

    const onboardingAfter = await app.request("http://pirate.test/onboarding/status", {
      headers: { authorization: `Bearer ${session.accessToken}` },
    }, ctx.env)
    const onboardingAfterBody = await json(onboardingAfter) as {
      generated_handle_assigned: boolean
      cleanup_rename_available: boolean
    }
    expect(onboardingAfterBody.generated_handle_assigned).toBe(false)
    expect(onboardingAfterBody.cleanup_rename_available).toBe(false)
  })
})
