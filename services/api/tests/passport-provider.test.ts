import { afterEach, describe, expect, test } from "bun:test"
import { getPassportProvider, setPassportProviderForTests } from "../src/lib/verification/passport-provider"
import { withFetchMock } from "./routes/verification/verification-test-helpers"

afterEach(() => {
  setPassportProviderForTests(null)
})

describe("Passport provider", () => {
  test("normalizes score response into wallet_score capability", async () => {
    await withFetchMock(async (input, init) => {
      expect(String(input)).toBe("https://passport.test/v2/stamps/42/score/0xabc")
      expect(init?.method).toBe("GET")
      expect((init?.headers as Record<string, string>)["X-API-KEY"]).toBe("passport-key")
      return Response.json({
        score: "33.538",
        last_score_timestamp: "2026-04-28T00:00:00.000Z",
        evidence: { threshold: "20" },
        stamp_scores: {
          Ens: "1.2",
        },
      })
    }, async () => {
      const provider = getPassportProvider({
        PASSPORT_API_URL: "https://passport.test",
        PASSPORT_API_KEY: "passport-key",
        PASSPORT_SCORER_ID: "42",
      })
      const score = await provider.refreshWalletScore({
        address: "0xabc",
        now: new Date("2026-04-28T01:00:00.000Z"),
      })
      expect(score).toMatchObject({
        state: "verified",
        provider: "passport",
        proof_type: "wallet_score",
        mechanism: "stamps-api-v2",
        score_decimal: "33.538",
        score_threshold_decimal: "20",
        passing_score: true,
        last_scored_at: 1777334400,
        stamps: [{ stamp_name: "Ens", stamp_score_decimal: "1.2" }],
      })
      expect(score.expires_at).toBe(1777424400)
    })
  })

  test("maps missing Passport score to unverified capability", async () => {
    await withFetchMock(async () => Response.json({ error: "Score not found" }, { status: 404 }), async () => {
      const provider = getPassportProvider({
        PASSPORT_API_URL: "https://passport.test",
        PASSPORT_API_KEY: "passport-key",
        PASSPORT_SCORER_ID: "42",
      })
      const score = await provider.refreshWalletScore({
        address: "0xabc",
        now: new Date("2026-04-28T01:00:00.000Z"),
      })
      expect(score).toMatchObject({
        state: "unverified",
        provider: "passport",
        proof_type: "wallet_score",
        mechanism: "stamps-api-v2",
        verified_at: null,
        score_decimal: null,
        score_threshold_decimal: null,
        passing_score: null,
        last_scored_at: 1777338000,
        expires_at: null,
        stamps: null,
      })
    })
  })

  test("throws provider_unavailable when required config is missing", async () => {
    let error: unknown = null
    try {
      getPassportProvider({
        PASSPORT_SCORER_ID: "42",
      })
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({
      code: "provider_unavailable",
      status: 502,
    })
  })
})
