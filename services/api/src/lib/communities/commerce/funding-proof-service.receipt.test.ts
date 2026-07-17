import { afterEach, describe, expect, test } from "bun:test"
import { Interface } from "ethers"

import type { Env } from "../../../env"
import {
  setBuyerFundingProviderFactoryForTests,
  verifyPirateCheckoutUsdcFunding,
} from "./funding-proof-service"

const transfer = new Interface(["event Transfer(address indexed from, address indexed to, uint256 value)"])
const TOKEN = "0x036cbd53842c5426634e7929541ec2318f3dcf7e"
const BUYER = "0x1111111111111111111111111111111111111111"
const OPERATOR = "0x2222222222222222222222222222222222222222"
const OTHER = "0x3333333333333333333333333333333333333333"
const TX = `0x${"11".repeat(32)}`
const BLOCK = `0x${"22".repeat(32)}`

const env = {
  PIRATE_CHECKOUT_SOURCE_CHAIN_ID: "84532",
  PIRATE_CHECKOUT_USDC_TOKEN_ADDRESS: TOKEN,
  PIRATE_CHECKOUT_OPERATOR_ADDRESS: OPERATOR,
  PIRATE_CHECKOUT_RPC_URL: "https://rpc.invalid",
} as Env

function log(input: { from?: string; to?: string; amount?: bigint; index: number }) {
  const encoded = transfer.encodeEventLog(transfer.getEvent("Transfer")!, [
    input.from ?? BUYER,
    input.to ?? OPERATOR,
    input.amount ?? 5_000_000n,
  ])
  return { address: TOKEN, topics: encoded.topics, data: encoded.data, index: input.index }
}

function provide(logs: ReturnType<typeof log>[]) {
  setBuyerFundingProviderFactoryForTests(() => ({
    waitForTransaction: async () => ({ status: 1, blockNumber: 123, blockHash: BLOCK, logs }),
  } as never))
}

function verify() {
  return verifyPirateCheckoutUsdcFunding({
    env,
    quoteId: "quote_1",
    amountUsd: 5,
    buyerAddress: BUYER,
    fundingTxRef: TX,
  })
}

afterEach(() => setBuyerFundingProviderFactoryForTests(null))

describe("Pirate checkout raw funding receipt parser", () => {
  test.each([
    ["wrong amount", log({ amount: 4_999_999n, index: 1 })],
    ["wrong recipient", log({ to: OTHER, index: 1 })],
    ["wrong sender", log({ from: OTHER, index: 1 })],
  ])("rejects %s", async (_label, candidate) => {
    provide([candidate])
    await expect(verify()).rejects.toThrow("did not deliver enough USDC")
  })

  test("selects the first exact matching Transfer and preserves its log index", async () => {
    provide([
      log({ to: OTHER, index: 2 }),
      log({ amount: 5_000_000n, index: 7 }),
      log({ amount: 5_000_000n, index: 9 }),
    ])

    await expect(verify()).resolves.toMatchObject({
      txRef: TX,
      amountAtomic: "5000000",
      observation: { chainId: 84532, logIndex: 7, blockNumber: 123, blockHash: BLOCK },
    })
  })
})
