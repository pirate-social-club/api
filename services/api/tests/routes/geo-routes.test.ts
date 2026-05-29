import { afterEach, describe, expect, test } from "bun:test"
import { app } from "../../src/index"
import { buildTestEnv, json, mintUpstreamJwt, withMockedFetch } from "../helpers"
import type { Env } from "../../src/types"

async function exchangeJwt(env: Env, sub: string): Promise<string> {
  const jwt = await mintUpstreamJwt(env, { sub })
  const response = await app.request("http://pirate.test/auth/session/exchange", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      proof: {
        type: "jwt_based_auth",
        jwt,
      },
    }),
  }, env)
  const body = await json(response) as { access_token: string }
  return body.access_token
}

let cleanup: (() => void) | null = null

afterEach(() => {
  cleanup?.()
  cleanup = null
})

describe("geo routes", () => {
  test("normalizes Geoapify autocomplete places", async () => {
    const env = buildTestEnv({
      DEV_MEMORY_STORE_ENABLED: "true",
      ENVIRONMENT: "local",
      GEOAPIFY_API_KEY: "geoapify-test-key",
    })
    const token = await exchangeJwt(env, "geo-normalize-user")
    const requestedUrls: string[] = []

    const response = await withMockedFetch((originalFetch) => {
      cleanup = () => {
        globalThis.fetch = originalFetch
      }
      return (async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        if (url.startsWith("https://api.geoapify.com/v1/geocode/autocomplete")) {
          requestedUrls.push(url)
          return new Response(JSON.stringify({
            features: [
              {
                geometry: { coordinates: [44.79786, 41.71053] },
                properties: {
                  address_line1: "Left Bank",
                  address_line2: "Left Embankment, Tbilisi",
                  city: "Tbilisi",
                  country_code: "GE",
                  formatted: "Left Bank, Left Embankment, Tbilisi, Georgia",
                  name: "Left Bank",
                  place_id: "place-left-bank",
                },
              },
              {
                geometry: { coordinates: [44.80398, 41.70982] },
                properties: {
                  address_line1: "8 Egnate Ninoshvili St",
                  address_line2: "Tbilisi",
                  country_code: "ge",
                  formatted: "8 Egnate Ninoshvili St, Tbilisi, Georgia",
                },
              },
            ],
          }), {
            headers: { "content-type": "application/json" },
            status: 200,
          })
        }
        return originalFetch(input, init)
      }) as typeof fetch
    }, async () => await app.request(
        "http://pirate.test/geo/search?text=Left&limit=5&country=ge&biasLat=41.7&biasLon=44.8",
        { headers: { authorization: `Bearer ${token}` } },
        env,
      ))

    expect(response.status).toBe(200)
    expect(requestedUrls).toHaveLength(1)
    const upstream = new URL(requestedUrls[0] ?? "")
    expect(upstream.searchParams.get("text")).toBe("Left")
    expect(upstream.searchParams.get("limit")).toBe("5")
    expect(upstream.searchParams.get("filter")).toBe("countrycode:ge")
    expect(upstream.searchParams.get("bias")).toBe("proximity:44.8,41.7")
    expect(upstream.searchParams.get("apiKey")).toBe("geoapify-test-key")
    expect(await json(response)).toEqual({
      places: [
        {
          label: "Left Bank",
          address: "Left Embankment, Tbilisi",
          lat: 41.71053,
          lon: 44.79786,
          source: "geoapify",
          providerPlaceId: "place-left-bank",
          countryCode: "ge",
          city: "Tbilisi",
        },
        {
          label: "8 Egnate Ninoshvili St, Tbilisi, Georgia",
          address: "8 Egnate Ninoshvili St, Tbilisi",
          lat: 41.70982,
          lon: 44.80398,
          source: "geoapify",
          countryCode: "ge",
        },
      ],
    })
  })

  test("requires authentication", async () => {
    const env = buildTestEnv({
      DEV_MEMORY_STORE_ENABLED: "true",
      ENVIRONMENT: "local",
      GEOAPIFY_API_KEY: "geoapify-test-key",
    })

    const response = await app.request("http://pirate.test/geo/search?text=Left", {}, env)

    expect(response.status).toBe(401)
  })

  test("validates query, country, bias, and configuration", async () => {
    const env = buildTestEnv({
      DEV_MEMORY_STORE_ENABLED: "true",
      ENVIRONMENT: "local",
      GEOAPIFY_API_KEY: "geoapify-test-key",
    })
    const token = await exchangeJwt(env, "geo-validation-user")
    const headers = { authorization: `Bearer ${token}` }

    const shortQuery = await app.request("http://pirate.test/geo/search?text=L", { headers }, env)
    expect(shortQuery.status).toBe(400)

    const invalidCountry = await app.request("http://pirate.test/geo/search?text=Left&country=geo", { headers }, env)
    expect(invalidCountry.status).toBe(400)

    const missingBiasPair = await app.request("http://pirate.test/geo/search?text=Left&biasLat=41.7", { headers }, env)
    expect(missingBiasPair.status).toBe(400)

    const originalConsoleError = console.error
    console.error = () => undefined
    try {
      const missingKey = await app.request("http://pirate.test/geo/search?text=Left", { headers }, {
        ...env,
        GEOAPIFY_API_KEY: undefined,
      })
      expect(missingKey.status).toBe(502)
    } finally {
      console.error = originalConsoleError
    }
  })

  test("live Geoapify autocomplete smoke", async () => {
    if (process.env.GEOAPIFY_LIVE_TEST !== "1") {
      return
    }

    const apiKey = process.env.GEOAPIFY_API_KEY?.trim()
    if (!apiKey) {
      throw new Error("GEOAPIFY_API_KEY is required when GEOAPIFY_LIVE_TEST=1")
    }

    const env = buildTestEnv({
      DEV_MEMORY_STORE_ENABLED: "true",
      ENVIRONMENT: "local",
      GEOAPIFY_API_KEY: apiKey,
    })
    const token = await exchangeJwt(env, "geo-live-smoke-user")
    const response = await app.request(
      "http://pirate.test/geo/search?text=Left%20Bank&limit=5&country=ge&biasLat=41.7&biasLon=44.8",
      { headers: { authorization: `Bearer ${token}` } },
      env,
    )

    expect(response.status).toBe(200)
    const body = await json(response) as {
      places?: Array<{
        countryCode?: string
        label?: string
        lat?: number
        lon?: number
        source?: string
      }>
    }
    expect(Array.isArray(body.places)).toBe(true)
    expect(body.places?.length).toBeGreaterThan(0)
    expect(body.places?.[0]?.source).toBe("geoapify")
    expect(body.places?.[0]?.countryCode).toBe("ge")
    expect(typeof body.places?.[0]?.label).toBe("string")
    expect(typeof body.places?.[0]?.lat).toBe("number")
    expect(typeof body.places?.[0]?.lon).toBe("number")
  })
})
