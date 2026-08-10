#!/usr/bin/env bun

/**
 * Deterministically prepares and verifies the Base Sepolia policy-2 rewards
 * Lit Action. `source` writes the exact source bytes to stdout with no trailing
 * newline. `manifest` prints review and registration identifiers.
 * `verify-gateways` proves two independent public gateways return those bytes.
 *
 * This tool does not publish, pin, register, or change Lit permissions.
 */

import { createHash } from "node:crypto"
import { getAddress, keccak256, toUtf8Bytes } from "ethers"
import { base58btc } from "multiformats/bases/base58"

import { buildRewardVaultLitAction } from "../src/lib/rewards/reward-vault-lit-action"

const POLICY_1_SHA256 = "59b65894559e6feb454586f5aae6342f35f2100018a72889f8fcc55d9dd20155"
const POLICY_1_CID = "QmR9EqhLEK7jE1wp44wLanmeJwK3Wr3kPtsfD4pjAmogm7"
const POLICY_1_BYTE_LENGTH = 4_121
const POLICY_2_VERSION = 2n
const GATEWAYS = ["https://ipfs.io/ipfs", "https://dweb.link/ipfs"] as const

type Command = "source" | "manifest" | "verify-gateways"

function command(argv: string[]): { command: Command; cid: string | null } {
  const selected = argv[0] ?? "manifest"
  if (selected === "source" || selected === "manifest") return { command: selected, cid: null }
  if (selected === "verify-gateways") {
    const cid = argv[1] ?? ""
    if (!/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/u.test(cid)) {
      throw new Error("verify-gateways requires a CIDv0 argument")
    }
    return { command: selected, cid }
  }
  throw new Error("usage: prepare-lit-reward-action.ts [source|manifest|verify-gateways <cid>]")
}

function source(policyVersion: bigint): string {
  return buildRewardVaultLitAction({
    vaultAddress: "0x01c84e513CC823255A9651885Fb59E363B47d55a",
    signerAddress: "0x6a1C1a6C780E9F2eb23E564C04B6316864468c46",
    chainId: 84_532,
    policyVersion,
    maxDeadlineSeconds: 7_200,
    maxFeePerGasWei: 50_000_000_000n,
    maxPriorityFeePerGasWei: 25_000_000_000n,
    maxGasLimit: 300_000n,
  })
}

function concat(parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.byteLength, 0)
  const output = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

function varint(input: number): Uint8Array {
  if (!Number.isSafeInteger(input) || input < 0) throw new Error("invalid varint input")
  const bytes: number[] = []
  let value = input
  do {
    let byte = value & 0x7f
    value = Math.floor(value / 128)
    if (value > 0) byte |= 0x80
    bytes.push(byte)
  } while (value > 0)
  return Uint8Array.from(bytes)
}

/** CIDv0 produced by the default single-block UnixFS file importer. */
function unixFsCidV0(bytes: Uint8Array): string {
  const unixFsData = concat([
    Uint8Array.of(0x08, 0x02),
    Uint8Array.of(0x12),
    varint(bytes.byteLength),
    bytes,
    Uint8Array.of(0x18),
    varint(bytes.byteLength),
  ])
  const dagPbNode = concat([Uint8Array.of(0x0a), varint(unixFsData.byteLength), unixFsData])
  const digest = createHash("sha256").update(dagPbNode).digest()
  return base58btc.encode(concat([Uint8Array.of(0x12, 0x20), digest])).slice(1)
}

function metadata(actionSource: string): {
  byte_length: number
  sha256: string
  expected_cid: string
  lit_cid_hash: string
} {
  const bytes = new TextEncoder().encode(actionSource)
  const expectedCid = unixFsCidV0(bytes)
  return {
    byte_length: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    expected_cid: expectedCid,
    lit_cid_hash: keccak256(toUtf8Bytes(expectedCid)),
  }
}

function verifyArchivedBaseline(): void {
  const baseline = metadata(source(1n))
  if (
    baseline.byte_length !== POLICY_1_BYTE_LENGTH
    || baseline.sha256 !== POLICY_1_SHA256
    || baseline.expected_cid !== POLICY_1_CID
  ) {
    throw new Error("the action generator no longer reproduces the archived policy-1 artifact")
  }
}

async function verifyGateways(cid: string, expected: ReturnType<typeof metadata>): Promise<void> {
  if (cid !== expected.expected_cid) {
    throw new Error(`CID ${cid} does not match the deterministic policy-2 CID ${expected.expected_cid}`)
  }
  const observations = []
  for (const gateway of GATEWAYS) {
    const startedAt = performance.now()
    const response = await fetch(`${gateway}/${cid}`, { redirect: "error" })
    const bytes = new Uint8Array(await response.arrayBuffer())
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const observation = {
      gateway,
      status: response.status,
      byte_length: bytes.byteLength,
      sha256,
      latency_ms: Math.round(performance.now() - startedAt),
    }
    observations.push(observation)
    if (!response.ok || bytes.byteLength !== expected.byte_length || sha256 !== expected.sha256) {
      throw new Error(`gateway verification failed: ${JSON.stringify(observation)}`)
    }
  }
  console.log(JSON.stringify({ cid, verified_at: new Date().toISOString(), observations }, null, 2))
}

async function main(): Promise<void> {
  verifyArchivedBaseline()
  const selected = command(process.argv.slice(2))
  const actionSource = source(POLICY_2_VERSION)
  const prepared = metadata(actionSource)
  if (selected.command === "source") {
    process.stdout.write(actionSource)
    return
  }
  if (selected.command === "verify-gateways") {
    await verifyGateways(selected.cid as string, prepared)
    return
  }
  console.log(JSON.stringify({
    schema_version: 1,
    artifact: "rewards-vault-action.staging-84532.policy-2.js",
    policy: {
      chain_id: 84_532,
      policy_version: POLICY_2_VERSION.toString(),
      vault_address: getAddress("0x01c84e513CC823255A9651885Fb59E363B47d55a"),
      signer_address: getAddress("0x6a1C1a6C780E9F2eb23E564C04B6316864468c46"),
      max_deadline_seconds: 7_200,
      max_fee_per_gas_wei: "50000000000",
      max_priority_fee_per_gas_wei: "25000000000",
      max_gas_limit: "300000",
    },
    source: prepared,
    archived_policy_1_baseline_verified: true,
    ceremony_order: [
      "render exact source bytes",
      "pin under the expected CID",
      "verify both public gateways",
      "register the policy-2 CID and remove the retired CID from group 1",
    ],
  }, null, 2))
}

await main()
