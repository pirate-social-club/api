import { describe, expect, test } from "bun:test"
import { verifyHnsTxtChallenge } from "../src/lib/verification/hns-verifier"
import type { Env } from "../src/types"

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    HNS_VERIFICATION_PROVIDER: "hnsdoh",
    HNS_RESOLVER_HOST: "hnsdoh.com",
    HNS_ASSUME_EXPIRY_HORIZON_SUFFICIENT: "true",
    ...overrides,
  }
}

describe("hns verifier", () => {
  test("returns challenge_pending when the TXT challenge is not yet visible", async () => {
    const observation = await verifyHnsTxtChallenge(buildEnv(), {
      normalizedRootLabel: "demo-root",
      challengeHost: "_pirate.demo-root",
      challengeTxtValue: "pirate-verification=nvs_demo",
    }, {
      async createResolver() {
        return {
          resolveTxt(name: string) {
            if (name === "demo-root") {
              return Promise.resolve([["root-txt"]])
            }
            return Promise.resolve([])
          },
          resolveNs() {
            return Promise.resolve(["ns1.example."])
          },
          resolve4() {
            return Promise.resolve([])
          },
          resolve6() {
            return Promise.resolve([])
          },
          resolveCname() {
            return Promise.resolve([])
          },
        }
      },
    })

    expect(observation.kind).toBe("challenge_pending")
    if (observation.kind !== "challenge_pending") {
      throw new Error(`expected challenge_pending, received ${observation.kind}`)
    }
    expect(observation.failureReason).toBe("challenge_not_visible")
    expect(observation.rootExists).toBe(true)
  })

  test("returns verified when the expected TXT challenge is visible", async () => {
    const observation = await verifyHnsTxtChallenge(buildEnv({
      HNS_PIRATE_NS_HOSTS: "ns1.pirate.example.",
    }), {
      normalizedRootLabel: "demo-root",
      challengeHost: "_pirate.demo-root",
      challengeTxtValue: "pirate-verification=nvs_demo",
    }, {
      async createResolver() {
        return {
          resolveTxt(name: string) {
            if (name === "_pirate.demo-root") {
              return Promise.resolve([["pirate-verification=nvs_demo"]])
            }
            return Promise.resolve([])
          },
          resolveNs() {
            return Promise.resolve(["ns1.pirate.example."])
          },
          resolve4() {
            return Promise.resolve(["203.0.113.10"])
          },
          resolve6() {
            return Promise.resolve([])
          },
          resolveCname() {
            return Promise.resolve([])
          },
        }
      },
    })

    expect(observation.kind).toBe("verified")
    if (observation.kind !== "verified") {
      throw new Error(`expected verified, received ${observation.kind}`)
    }
    expect(observation.rootControlVerified).toBe(true)
    expect(observation.routingEnabled).toBe(true)
    expect(observation.pirateDnsAuthorityVerified).toBe(true)
    expect(observation.operationClass).toBe("pirate_delegated_namespace")
  })
})
