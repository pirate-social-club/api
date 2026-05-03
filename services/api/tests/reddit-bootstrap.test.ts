import { afterEach, describe, expect, test } from "bun:test"
import { checkRedditVerificationCode } from "../src/lib/onboarding/reddit-bootstrap"
import { buildTestEnv } from "./helpers"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("reddit verification checker", () => {
  test("reports a different active Pirate verification code separately", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: {
        subreddit: {
          public_description: "pirate-verification=b3e131be13f34fcf",
          description: "",
        },
      },
    }), { status: 200 })) as typeof globalThis.fetch

    const result = await checkRedditVerificationCode({
      env: buildTestEnv(),
      redditUsername: "technohippi3",
      verificationCode: "pirate-verification=fbebe67539f54db2",
    })

    expect(result).toEqual({
      status: "pending",
      failureCode: "different_code_found",
    })
  })
})
