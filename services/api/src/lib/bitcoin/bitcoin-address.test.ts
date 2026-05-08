import { describe, expect, test } from "bun:test"
import {
  BITCOIN_MAINNET_NAMESPACE,
  BITCOIN_TESTNET_NAMESPACE,
  parseBitcoinAddress,
} from "./bitcoin-address"

describe("parseBitcoinAddress", () => {
  test("derives p2pkh script pubkeys", () => {
    const parsed = parseBitcoinAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")

    expect(parsed).toMatchObject({
      addressNormalized: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
      chainNamespace: BITCOIN_MAINNET_NAMESPACE,
      network: "mainnet",
      kind: "p2pkh",
      scriptPubkeyHex: "76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac",
    })
  })

  test("derives segwit script pubkeys and normalizes casing", () => {
    const parsed = parseBitcoinAddress("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4")

    expect(parsed).toMatchObject({
      addressNormalized: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
      chainNamespace: BITCOIN_MAINNET_NAMESPACE,
      network: "mainnet",
      kind: "p2wpkh",
      scriptPubkeyHex: "0014751e76e8199196d454941c45d1b3a323f1433bd6",
    })
  })

  test("derives taproot script pubkeys", () => {
    const parsed = parseBitcoinAddress("bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr")

    expect(parsed).toMatchObject({
      chainNamespace: BITCOIN_MAINNET_NAMESPACE,
      network: "mainnet",
      kind: "p2tr",
      scriptPubkeyHex: "5120a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c",
    })
  })

  test("rejects invalid checksums", () => {
    expect(parseBitcoinAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt081")).toBeNull()
    expect(parseBitcoinAddress("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb")).toBeNull()
  })

  test("recognizes testnet addresses", () => {
    const parsed = parseBitcoinAddress("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx")

    expect(parsed).toMatchObject({
      chainNamespace: BITCOIN_TESTNET_NAMESPACE,
      network: "testnet",
      kind: "p2wpkh",
    })
  })
})
