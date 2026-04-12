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

type MockResolver = {
  resolveTxt(name: string): Promise<string[][]>
  resolveNs(name: string): Promise<string[]>
  resolve4(name: string): Promise<string[]>
  resolve6(name: string): Promise<string[]>
  resolveCname(name: string): Promise<string[]>
}

function buildResolver(overrides: Partial<MockResolver> = {}): MockResolver {
  return {
    resolveTxt() {
      return Promise.resolve([])
    },
    resolveNs() {
      return Promise.resolve([])
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
        return buildResolver({
          resolveTxt(name: string) {
            if (name === "demo-root") {
              return Promise.resolve([["root-txt"]])
            }
            return Promise.resolve([])
          },
          resolveNs() {
            return Promise.resolve(["ns1.example."])
          },
        })
      },
    })

    expect(observation.kind).toBe("challenge_pending")
    if (observation.kind !== "challenge_pending") {
      throw new Error(`expected challenge_pending, received ${observation.kind}`)
    }
    expect(observation.failureReason).toBe("challenge_not_visible")
    expect(observation.rootExists).toBe(true)
    expect(observation.rawResponse.verification_basis).toBe("dns_txt_zone_control")
    expect(observation.rawResponse.ownership_scope).toBe("zone_control_not_onchain_root_ownership")
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
        return buildResolver({
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
        })
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
    expect(observation.rawResponse.verification_basis).toBe("dns_txt_zone_control")
    expect(observation.rawResponse.ownership_scope).toBe("zone_control_not_onchain_root_ownership")
    expect(observation.rawResponse.control_class_basis).toBe("assumed_single_holder_root_for_v0")
    expect(observation.rawResponse.expiry_horizon_basis).toBe("assumed_true_from_env")
  })

  test("returns failed when the root does not resolve at all", async () => {
    const observation = await verifyHnsTxtChallenge(buildEnv(), {
      normalizedRootLabel: "missing-root",
      challengeHost: "_pirate.missing-root",
      challengeTxtValue: "pirate-verification=nvs_demo",
    }, {
      async createResolver() {
        return buildResolver()
      },
    })

    expect(observation.kind).toBe("failed")
    if (observation.kind !== "failed") {
      throw new Error(`expected failed, received ${observation.kind}`)
    }
    expect(observation.failureReason).toBe("root_not_found")
    expect(observation.rootExists).toBe(false)
  })

  test("returns failed when the visible TXT value does not match the challenge", async () => {
    const observation = await verifyHnsTxtChallenge(buildEnv(), {
      normalizedRootLabel: "demo-root",
      challengeHost: "_pirate.demo-root",
      challengeTxtValue: "pirate-verification=nvs_demo",
    }, {
      async createResolver() {
        return buildResolver({
          resolveTxt(name: string) {
            if (name === "_pirate.demo-root") {
              return Promise.resolve([["pirate-verification=wrong"]])
            }
            return Promise.resolve([])
          },
          resolveNs() {
            return Promise.resolve(["ns1.example."])
          },
        })
      },
    })

    expect(observation.kind).toBe("failed")
    if (observation.kind !== "failed") {
      throw new Error(`expected failed, received ${observation.kind}`)
    }
    expect(observation.failureReason).toBe("wrong_txt_value")
    expect(observation.rootExists).toBe(true)
  })

  test("returns failed when the resolver host is unavailable", async () => {
    const observation = await verifyHnsTxtChallenge(buildEnv(), {
      normalizedRootLabel: "demo-root",
      challengeHost: "_pirate.demo-root",
      challengeTxtValue: "pirate-verification=nvs_demo",
    }, {
      async createResolver() {
        throw new Error("resolver_unavailable")
      },
    })

    expect(observation.kind).toBe("failed")
    if (observation.kind !== "failed") {
      throw new Error(`expected failed, received ${observation.kind}`)
    }
    expect(observation.failureReason).toBe("resolver_unavailable")
    expect(observation.rootExists).toBe(false)
  })

  test("returns failed when the resolver throws an unexpected error", async () => {
    const observation = await verifyHnsTxtChallenge(buildEnv(), {
      normalizedRootLabel: "demo-root",
      challengeHost: "_pirate.demo-root",
      challengeTxtValue: "pirate-verification=nvs_demo",
    }, {
      async createResolver() {
        return buildResolver({
          resolveTxt() {
            throw new Error("dns blew up")
          },
        })
      },
    })

    expect(observation.kind).toBe("failed")
    if (observation.kind !== "failed") {
      throw new Error(`expected failed, received ${observation.kind}`)
    }
    expect(observation.failureReason).toBe("resolver_error")
    expect(observation.rootExists).toBe(false)
    expect(observation.rawResponse.verification_basis).toBe("dns_txt_zone_control")
    expect(observation.rawResponse.ownership_scope).toBe("zone_control_not_onchain_root_ownership")
    expect(observation.rawResponse.message).toBe("dns blew up")
  })
})
