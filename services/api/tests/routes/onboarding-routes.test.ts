import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../../src/index"
import { setRedditSnapshotImporterForTests, setRedditVerificationCheckerForTests } from "../../src/lib/onboarding/reddit-bootstrap"
import { buildTestEnv, createRouteTestContext, json, mintUpstreamJwt, resetRuntimeCaches } from "../helpers"
import type { Env } from "../../src/types"

let cleanup: (() => Promise<void>) | null = null

function requestJson(url: string, body: unknown, env: Env, token?: string): Promise<Response> {
  return Promise.resolve(app.request(
    url,
    {
      method: "POST",
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
  const response = await requestJson("http://pirate.test/auth/session/exchange", {
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

describe("onboarding reddit routes", () => {
  test("memory-mode reddit verification passes the raw code to the checker instead of the hint text", async () => {
    const env = buildTestEnv()
    const session = await exchangeJwt(env, "reddit-memory-user")

    const createdVerification = await requestJson("http://pirate.test/onboarding/reddit-verification", {
      reddit_username: "u/MemoryUser",
    }, env, session.accessToken)
    expect(createdVerification.status).toBe(200)
    const createdVerificationBody = await json(createdVerification) as {
      verification_hint: string | null
    }
    expect(typeof createdVerificationBody.verification_hint).toBe("string")
    const rawCode = createdVerificationBody.verification_hint?.match(/`([^`]+)`/)?.[1] ?? null
    expect(typeof rawCode).toBe("string")

    let seenVerificationCode: string | null = null
    setRedditVerificationCheckerForTests(async ({ verificationCode }) => {
      seenVerificationCode = verificationCode
      return {
        status: "verified",
      }
    })

    const verifiedVerification = await requestJson("http://pirate.test/onboarding/reddit-verification", {
      reddit_username: "memoryuser",
    }, env, session.accessToken)
    expect(verifiedVerification.status).toBe(200)
    expect(seenVerificationCode).toBe(rawCode)
  })

  test("reddit verification and import summary work through the full route stack", async () => {
    const ctx = await createRouteTestContext({
      ANALYTICS_ENABLED: "true",
      ANALYTICS_HMAC_SECRET: "analytics-secret",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "reddit-onboarding-user")

    const createdVerification = await requestJson("http://pirate.test/onboarding/reddit-verification", {
      reddit_username: "u/TechnoHippie",
    }, ctx.env, session.accessToken)
    expect(createdVerification.status).toBe(200)
    const createdVerificationBody = await json(createdVerification) as {
      reddit_username: string
      status: string
      verification_hint: string | null
      code_placement_surface: string | null
      failure_code: string | null
    }
    expect(createdVerificationBody.reddit_username).toBe("technohippie")
    expect(createdVerificationBody.status).toBe("pending")
    expect(typeof createdVerificationBody.verification_hint).toBe("string")
    expect(createdVerificationBody.code_placement_surface).toBe("profile")
    expect(createdVerificationBody.failure_code).toBeNull()

    setRedditVerificationCheckerForTests(async ({ verificationCode }) => {
      if (typeof createdVerificationBody.verification_hint === "string" && createdVerificationBody.verification_hint.includes(verificationCode)) {
        return {
          status: "verified" as const,
        }
      }
      return {
        status: "pending" as const,
        failureCode: "code_not_found" as const,
      }
    })

    const verifiedVerification = await requestJson("http://pirate.test/onboarding/reddit-verification", {
      reddit_username: "technohippie",
    }, ctx.env, session.accessToken)
    expect(verifiedVerification.status).toBe(200)
    const verifiedBody = await json(verifiedVerification) as {
      status: string
      last_checked_at: string | null
      failure_code: string | null
    }
    expect(verifiedBody.status).toBe("verified")
    expect(typeof verifiedBody.last_checked_at).toBe("string")
    expect(verifiedBody.failure_code).toBeNull()

    setRedditSnapshotImporterForTests(async ({ redditUsername }) => ({
      reddit_username: redditUsername,
      imported_at: "2026-04-10T12:00:00.000Z",
      account_age_days: 1200,
      imported_reddit_score: 42000,
      top_subreddits: [
        {
          subreddit: "hiphopheads",
          karma: 12000,
          posts: 44,
          rank_source: "karma",
        },
      ],
      moderator_of: ["examplemodclub"],
      inferred_interests: ["hip-hop", "music"],
      suggested_communities: [
        {
          community_id: "cmt_hiphop",
          name: "Hip Hop",
          reason: "Based on your Reddit history",
        },
      ],
      coverage_note: "Historical archival snapshot.",
    }))

    const importResponse = await requestJson("http://pirate.test/onboarding/reddit-imports", {
      reddit_username: "technohippie",
    }, ctx.env, session.accessToken)
    expect(importResponse.status).toBe(202)
    const importBody = await json(importResponse) as {
      job: { job_type: string; status: string; result_ref: string | null }
    }
    expect(importBody.job.job_type).toBe("reddit_snapshot_import")
    expect(importBody.job.status).toBe("succeeded")
    expect(typeof importBody.job.result_ref).toBe("string")

    const onboarding = await app.request("http://pirate.test/onboarding/status", {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
      },
    }, ctx.env)
    expect(onboarding.status).toBe(200)
    const onboardingBody = await json(onboarding) as {
      reddit_verification_status: string
      reddit_import_status: string
      suggested_community_ids: string[]
    }
    expect(onboardingBody.reddit_verification_status).toBe("verified")
    expect(onboardingBody.reddit_import_status).toBe("succeeded")
    expect(onboardingBody.suggested_community_ids).toEqual(["cmt_hiphop"])

    const summary = await app.request("http://pirate.test/onboarding/reddit-imports/latest", {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
      },
    }, ctx.env)
    expect(summary.status).toBe(200)
    const summaryBody = await json(summary) as {
      reddit_username: string
      imported_reddit_score: number | null
      suggested_communities: Array<{ community_id: string; name: string; reason: string }>
    }
    expect(summaryBody.reddit_username).toBe("technohippie")
    expect(summaryBody.imported_reddit_score).toBe(42000)
    expect(summaryBody.suggested_communities).toEqual([{
      community_id: "cmt_hiphop",
      name: "Hip Hop",
      reason: "Based on your Reddit history",
    }])

    const analytics = await ctx.client.execute({
      sql: `
        SELECT properties_json
        FROM analytics_outbox
        WHERE event_name = 'reddit_import_succeeded'
        ORDER BY created_at DESC
        LIMIT 1
      `,
    })
    const analyticsProperties = JSON.parse(String(analytics.rows[0]?.properties_json ?? "{}")) as {
      imported_reddit_score_bucket?: string
      top_subreddit_count?: number
      suggested_community_count?: number
      has_imported_reddit_score?: boolean
    }
    expect(analyticsProperties.imported_reddit_score_bucket).toBe("10k_50k")
    expect(analyticsProperties.top_subreddit_count).toBe(1)
    expect(analyticsProperties.suggested_community_count).toBe(1)
    expect(analyticsProperties.has_imported_reddit_score).toBe(true)
  })

  test("dismiss persists onboarding completion without consuming cleanup rename", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "reddit-onboarding-dismiss-user")

    const dismissResponse = await app.request("http://pirate.test/onboarding/dismiss", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.accessToken}`,
      },
    }, ctx.env)
    expect(dismissResponse.status).toBe(200)
    const dismissBody = await json(dismissResponse) as {
      cleanup_rename_available: boolean
      onboarding_dismissed_at: string | null
    }
    expect(dismissBody.cleanup_rename_available).toBe(true)
    expect(typeof dismissBody.onboarding_dismissed_at).toBe("string")

    const onboarding = await app.request("http://pirate.test/onboarding/status", {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
      },
    }, ctx.env)
    expect(onboarding.status).toBe(200)
    const onboardingBody = await json(onboarding) as {
      cleanup_rename_available: boolean
      onboarding_dismissed_at: string | null
    }
    expect(onboardingBody.cleanup_rename_available).toBe(true)
    expect(onboardingBody.onboarding_dismissed_at).toBe(dismissBody.onboarding_dismissed_at)
  })
})
