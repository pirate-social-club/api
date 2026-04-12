import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../src/index"
import { setRedditSnapshotImporterForTests, setRedditVerificationCheckerForTests } from "../src/lib/onboarding/reddit-bootstrap"
import { buildTestEnv, createRouteTestContext, createTestExecutionContext, json, mintUpstreamJwt, resetRuntimeCaches } from "./helpers"
import type { Env } from "../src/types"

let cleanup: (() => Promise<void>) | null = null

function requestJson(
  url: string,
  body: unknown,
  env: Env,
  token?: string,
  executionCtx?: { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void },
): Promise<Response> {
  const request = new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  return Promise.resolve(app.fetch(request, env as never, executionCtx as never))
}

async function insertRedditImportJob(input: {
  env: Env
  userId: string
  redditUsername: string
  jobId: string
  status: "queued" | "running" | "succeeded" | "failed"
  updatedAt: string
  createdAt?: string
  resultRef?: string | null
  errorCode?: string | null
}): Promise<void> {
  const { createClient } = await import("@libsql/client")
  const client = createClient({
    url: String(input.env.CONTROL_PLANE_DATABASE_URL),
  })

  try {
    await client.execute({
      sql: `
        INSERT INTO jobs (
          job_id, job_type, job_scope, community_id, subject_type, subject_id, status, payload_json,
          result_ref, error_code, attempt_count, available_at, created_at, updated_at
        ) VALUES (
          ?1, 'reddit_snapshot_import', 'platform', NULL, 'user', ?2, ?3, ?4,
          ?5, ?6, 0, NULL, ?7, ?8
        )
      `,
      args: [
        input.jobId,
        input.userId,
        input.status,
        JSON.stringify({ reddit_username: input.redditUsername }),
        input.resultRef ?? null,
        input.errorCode ?? null,
        input.createdAt ?? input.updatedAt,
        input.updatedAt,
      ],
    })
  } finally {
    client.close()
  }
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
    const ctx = await createRouteTestContext()
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
      global_karma: 42000,
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

    const background = createTestExecutionContext()
    const importResponse = await requestJson("http://pirate.test/onboarding/reddit-imports", {
      reddit_username: "technohippie",
    }, ctx.env, session.accessToken, background.executionCtx)
    expect(importResponse.status).toBe(202)
    const importBody = await json(importResponse) as {
      job: { job_type: string; status: string; result_ref: string | null }
    }
    expect(importBody.job.job_type).toBe("reddit_snapshot_import")
    expect(importBody.job.status).toBe("queued")
    expect(importBody.job.result_ref).toBeNull()

    await background.drain()

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
      global_karma: number | null
      suggested_communities: Array<{ community_id: string; name: string; reason: string }>
    }
    expect(summaryBody.reddit_username).toBe("technohippie")
    expect(summaryBody.global_karma).toBe(42000)
    expect(summaryBody.suggested_communities).toEqual([{
      community_id: "cmt_hiphop",
      name: "Hip Hop",
      reason: "Based on your Reddit history",
    }])
  })

  test("internal reddit import drain recovers stale running jobs and does not rerun succeeded ones", async () => {
    const ctx = await createRouteTestContext({
      INTERNAL_JOB_RUNNER_TOKEN: "runner-secret",
      REDDIT_IMPORT_JOB_STALE_AFTER_SECONDS: "300",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "reddit-job-recovery-user")

    const createdVerification = await requestJson("http://pirate.test/onboarding/reddit-verification", {
      reddit_username: "u/RecoveredUser",
    }, ctx.env, session.accessToken)
    expect(createdVerification.status).toBe(200)
    const createdVerificationBody = await json(createdVerification) as {
      verification_hint: string | null
    }
    const rawCode = createdVerificationBody.verification_hint?.match(/`([^`]+)`/)?.[1] ?? null
    setRedditVerificationCheckerForTests(async ({ verificationCode }) => verificationCode === rawCode
      ? { status: "verified" as const }
      : { status: "pending" as const, failureCode: "code_not_found" as const })

    const verified = await requestJson("http://pirate.test/onboarding/reddit-verification", {
      reddit_username: "recovereduser",
    }, ctx.env, session.accessToken)
    expect(verified.status).toBe(200)

    let importCallCount = 0
    setRedditSnapshotImporterForTests(async ({ redditUsername }) => {
      importCallCount += 1
      return {
        reddit_username: redditUsername,
        imported_at: "2026-04-10T13:00:00.000Z",
        account_age_days: 365,
        global_karma: 1234,
        top_subreddits: [],
        moderator_of: [],
        inferred_interests: [],
        suggested_communities: [],
        coverage_note: "Recovered snapshot.",
      }
    })

    await insertRedditImportJob({
      env: ctx.env,
      userId: session.userId,
      redditUsername: "recovereduser",
      jobId: "job_stale_running_reddit",
      status: "running",
      updatedAt: "2026-04-10T12:00:00.000Z",
      createdAt: "2026-04-10T12:00:00.000Z",
    })

    const drain = await app.request(
      "http://pirate.test/jobs/internal/reddit-imports/drain",
      {
        method: "POST",
        headers: {
          authorization: "Bearer runner-secret",
        },
      },
      ctx.env,
    )
    expect(drain.status).toBe(200)
    const drainBody = await json(drain) as {
      recovered_count: number
      drained_count: number
    }
    expect(drainBody.recovered_count).toBe(1)
    expect(drainBody.drained_count).toBe(1)
    expect(importCallCount).toBe(1)

    const summary = await app.request("http://pirate.test/onboarding/reddit-imports/latest", {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
      },
    }, ctx.env)
    expect(summary.status).toBe(200)

    const secondDrain = await app.request(
      "http://pirate.test/jobs/internal/reddit-imports/drain",
      {
        method: "POST",
        headers: {
          authorization: "Bearer runner-secret",
        },
      },
      ctx.env,
    )
    expect(secondDrain.status).toBe(200)
    const secondDrainBody = await json(secondDrain) as {
      recovered_count: number
      drained_count: number
    }
    expect(secondDrainBody.recovered_count).toBe(0)
    expect(secondDrainBody.drained_count).toBe(0)
    expect(importCallCount).toBe(1)
  })
})

describe("global handle availability", () => {
  test("valid and free label returns available", async () => {
    const env = buildTestEnv()
    const session = await exchangeJwt(env, "availability-free-user")

    const response = await app.request(
      "http://pirate.test/onboarding/global-handle-availability?label=freename",
      { headers: { authorization: `Bearer ${session.accessToken}` } },
      env,
    )
    expect(response.status).toBe(200)
    const body = await json(response) as { label: string; status: string }
    expect(body.label).toBe("freename")
    expect(body.status).toBe("available")
  })

  test("taken label returns taken", async () => {
    const env = buildTestEnv()
    const first = await exchangeJwt(env, "availability-taken-first")
    const second = await exchangeJwt(env, "availability-taken-second")

    await requestJson("http://pirate.test/profiles/me/global-handle/rename", {
      desired_label: "takenhandle",
    }, env, first.accessToken)

    const response = await app.request(
      "http://pirate.test/onboarding/global-handle-availability?label=takenhandle",
      { headers: { authorization: `Bearer ${second.accessToken}` } },
      env,
    )
    expect(response.status).toBe(200)
    const body = await json(response) as { label: string; status: string }
    expect(body.status).toBe("taken")
  })

  test("reserved label returns reserved", async () => {
    const env = buildTestEnv()
    const session = await exchangeJwt(env, "availability-reserved-user")

    const response = await app.request(
      "http://pirate.test/onboarding/global-handle-availability?label=admin",
      { headers: { authorization: `Bearer ${session.accessToken}` } },
      env,
    )
    expect(response.status).toBe(200)
    const body = await json(response) as { label: string; status: string }
    expect(body.status).toBe("reserved")
  })

  test("malformed label returns invalid", async () => {
    const env = buildTestEnv()
    const session = await exchangeJwt(env, "availability-invalid-user")

    const response = await app.request(
      "http://pirate.test/onboarding/global-handle-availability?label=bad%20label",
      { headers: { authorization: `Bearer ${session.accessToken}` } },
      env,
    )
    expect(response.status).toBe(200)
    const body = await json(response) as { label: string; status: string }
    expect(body.status).toBe("invalid")
  })

  test("own active label returns available", async () => {
    const env = buildTestEnv()
    const session = await exchangeJwt(env, "availability-own-user")

    const profileResponse = await app.request(
      "http://pirate.test/profiles/me",
      { headers: { authorization: `Bearer ${session.accessToken}` } },
      env,
    )
    const profile = await json(profileResponse) as {
      global_handle: { label: string }
    }
    const ownLabel = profile.global_handle.label.replace(/\.pirate$/i, "")

    const response = await app.request(
      `http://pirate.test/onboarding/global-handle-availability?label=${ownLabel}`,
      { headers: { authorization: `Bearer ${session.accessToken}` } },
      env,
    )
    expect(response.status).toBe(200)
    const body = await json(response) as { label: string; status: string }
    expect(body.status).toBe("available")
  })

  test("unauthenticated request returns 401", async () => {
    const env = buildTestEnv()

    const response = await app.request(
      "http://pirate.test/onboarding/global-handle-availability?label=testname",
      {},
      env,
    )
    expect(response.status).toBe(401)
  })

  test("missing label parameter returns 400", async () => {
    const env = buildTestEnv()
    const session = await exchangeJwt(env, "availability-missing-label-user")

    const response = await app.request(
      "http://pirate.test/onboarding/global-handle-availability",
      { headers: { authorization: `Bearer ${session.accessToken}` } },
      env,
    )
    expect(response.status).toBe(400)
  })
})
