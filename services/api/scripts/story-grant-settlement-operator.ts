#!/usr/bin/env bun

import { createPublicClient, encodeFunctionData, http, parseEther } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { readDevVarsFromCwd } from "./_lib/dev-vars"

const settlementAbi = [
  {
    type: "function",
    name: "setSettlementOperator",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "active", type: "bool" },
    ],
    outputs: [],
  },
] as const

async function waitForReceipt(
  client: ReturnType<typeof createPublicClient>,
  txHash: `0x${string}`,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const receipt = await client.request({
      method: "eth_getTransactionReceipt",
      params: [txHash],
    }) as { status?: string } | null
    if (receipt?.status) {
      if (receipt.status !== "0x1") {
        throw new Error(`tx_reverted:${txHash}`)
      }
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`receipt_timeout:${txHash}`)
}

function resolveEnv(name: string, fallback = ""): string {
  return process.env[name] || readDevVarsFromCwd()[name] || fallback
}

function readArg(name: string): string | null {
  const args = process.argv.slice(2)
  const index = args.indexOf(name)
  if (index === -1) return null
  return args[index + 1] || null
}

function requireAddress(value: string | null | undefined, label: string): `0x${string}` {
  const normalized = String(value || "").trim()
  if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) {
    throw new Error(`${label}_invalid`)
  }
  return normalized as `0x${string}`
}

function requirePrivateKey(value: string | null | undefined, label: string): `0x${string}` {
  const normalized = String(value || "").trim()
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new Error(`${label}_invalid`)
  }
  return normalized as `0x${string}`
}

async function main(): Promise<void> {
  const operator = requireAddress(readArg("--operator"), "operator")
  const settlementContract = requireAddress(
    readArg("--settlement-contract") || resolveEnv("STORY_MARKETPLACE_SETTLEMENT_ADDRESS", "0xFECcC2cF8C9946E1384eF5733B509ac70677c5bd"),
    "settlement_contract",
  )
  const rpcUrl = String(readArg("--rpc-url") || resolveEnv("STORY_AENEID_RPC_URL", "https://rpc.ankr.com/story_aeneid_testnet")).trim()
  if (!rpcUrl) {
    throw new Error("rpc_url_missing")
  }
  const ownerPrivateKey = requirePrivateKey(
    readArg("--owner-private-key") || resolveEnv("STORY_CONTRACT_OWNER_PRIVATE_KEY"),
    "story_contract_owner_private_key",
  )
  const fundAmount = String(readArg("--fund-amount") || "").trim()

  const account = privateKeyToAccount(ownerPrivateKey)
  const publicClient = createPublicClient({
    transport: http(rpcUrl),
  })
  const nonceHex = await publicClient.request({
    method: "eth_getTransactionCount",
    params: [account.address, "pending"],
  })
  const nonce = Number(BigInt(String(nonceHex)))

  const grantSerializedTx = await account.signTransaction({
    type: "eip1559",
    chainId: 1315,
    nonce,
    to: settlementContract,
    value: 0n,
    data: encodeFunctionData({
      abi: settlementAbi,
      functionName: "setSettlementOperator",
      args: [operator, true],
    }),
    gas: 150000n,
    maxFeePerGas: 1000000000n,
    maxPriorityFeePerGas: 100000000n,
  })
  const grantTxHash = await publicClient.request({
    method: "eth_sendRawTransaction",
    params: [grantSerializedTx],
  })
  await waitForReceipt(publicClient, grantTxHash)

  let fundTxHash: `0x${string}` | null = null
  if (fundAmount) {
    const fundSerializedTx = await account.signTransaction({
      type: "eip1559",
      chainId: 1315,
      nonce: nonce + 1,
      to: operator,
      value: parseEther(fundAmount),
      gas: 21000n,
      maxFeePerGas: 1000000000n,
      maxPriorityFeePerGas: 100000000n,
    })
    fundTxHash = await publicClient.request({
      method: "eth_sendRawTransaction",
      params: [fundSerializedTx],
    }) as `0x${string}`
    await waitForReceipt(publicClient, fundTxHash)
  }

  process.stdout.write(JSON.stringify({
    operator,
    settlement_contract: settlementContract,
    grant_tx_hash: grantTxHash,
    fund_tx_hash: fundTxHash,
  }, null, 2))
  process.stdout.write("\n")
}

await main().catch((error) => {
  console.error(`[story-grant-settlement-operator] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
