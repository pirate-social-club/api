import { describe, expect, test } from "bun:test"
import { getEvmJsonRpcProvider, hasEthereumRpcConfig, hasEvmRpcConfig } from "../src/lib/communities/community-token-gates"
import type { Env } from "../src/env"

describe("EVM RPC configuration", () => {
  test("reports no configuration when a chain's transport is unset", () => {
    // Regression: the mainnet URL used to be coerced with String() before the
    // empty check, so an unset secret became the literal string "undefined" —
    // a truthy value that passed the guard and produced a provider pointing at
    // a bogus URL. That turned "not configured" into an opaque network error
    // and made the state indistinguishable from a transient outage.
    expect(hasEvmRpcConfig({} as Env, "eip155:1")).toBe(false)
    expect(hasEvmRpcConfig({} as Env, "eip155:8453")).toBe(false)
    expect(getEvmJsonRpcProvider({} as Env, "eip155:1")).toBeNull()
    expect(getEvmJsonRpcProvider({} as Env, "eip155:8453")).toBeNull()
    expect(hasEthereumRpcConfig({} as Env)).toBe(false)
  })

  test("treats a blank or whitespace transport as unconfigured", () => {
    expect(hasEvmRpcConfig({ ETHEREUM_RPC_URL: "   " } as Env, "eip155:1")).toBe(false)
    expect(hasEvmRpcConfig({ BASE_MAINNET_RPC_URL: "" } as Env, "eip155:8453")).toBe(false)
  })

  test("resolves each chain from its own transport binding", () => {
    const env = { ETHEREUM_RPC_URL: "https://eth.example", BASE_MAINNET_RPC_URL: "https://base.example" } as Env
    expect(hasEvmRpcConfig(env, "eip155:1")).toBe(true)
    expect(hasEvmRpcConfig(env, "eip155:8453")).toBe(true)

    // A configured mainnet transport must never stand in for Base.
    const mainnetOnly = { ETHEREUM_RPC_URL: "https://eth.example" } as Env
    expect(hasEvmRpcConfig(mainnetOnly, "eip155:1")).toBe(true)
    expect(hasEvmRpcConfig(mainnetOnly, "eip155:8453")).toBe(false)
  })
})
