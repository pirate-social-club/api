import { JsonRpcProvider, Wallet, formatEther } from "ethers"
import type { Env } from "../src/types"
import {
  DEFAULT_STORY_RPC_URL,
  resolveStoryChainId,
  resolveStoryRpcUrl,
} from "../src/lib/story/story-runtime-config"

function normalizePrivateKey(raw: string | null | undefined): string | null {
  const value = String(raw || "").trim()
  if (!value) return null
  const withPrefix = value.startsWith("0x") ? value : `0x${value}`
  return /^0x[a-fA-F0-9]{64}$/.test(withPrefix) ? withPrefix : null
}

function parseRequiredNumberFlag(argv: string[], flagName: string): number {
  const raw = argv.find((value) => value.startsWith(`${flagName}=`))?.slice(flagName.length + 1).trim() || ""
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${flagName}: ${raw || "<empty>"}`)
  }
  return parsed
}

function parseOptionalNumberFlag(argv: string[], flagName: string): number | null {
  const raw = argv.find((value) => value.startsWith(`${flagName}=`))?.slice(flagName.length + 1).trim() || ""
  if (!raw) return null
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${flagName}: ${raw}`)
  }
  return parsed
}

function parseRequiredBigIntFlag(argv: string[], flagName: string): bigint {
  const raw = argv.find((value) => value.startsWith(`${flagName}=`))?.slice(flagName.length + 1).trim() || ""
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid ${flagName}: ${raw || "<empty>"}`)
  }
  return BigInt(raw)
}

async function waitForLatestNonce(params: {
  provider: JsonRpcProvider
  address: string
  latestRequired: number
  timeoutMs: number
}): Promise<void> {
  const startedAt = Date.now()
  while ((Date.now() - startedAt) < params.timeoutMs) {
    const latestNonce = await params.provider.getTransactionCount(params.address, "latest")
    if (latestNonce >= params.latestRequired) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500))
  }
  throw new Error(`cancel_tx_timeout:${params.latestRequired}`)
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const env = process.env as Env
  const ownerPrivateKey = normalizePrivateKey(env.STORY_RUNTIME_FUNDER_PRIVATE_KEY)
    ?? normalizePrivateKey(env.STORY_CONTRACT_OWNER_PRIVATE_KEY)
  if (!ownerPrivateKey) {
    throw new Error("STORY_RUNTIME_FUNDER_PRIVATE_KEY or STORY_CONTRACT_OWNER_PRIVATE_KEY missing/invalid")
  }

  const nonce = parseRequiredNumberFlag(args, "--nonce")
  const endNonce = parseOptionalNumberFlag(args, "--end-nonce") ?? nonce
  if (endNonce < nonce) {
    throw new Error(`Invalid nonce range: ${nonce}..${endNonce}`)
  }
  const maxFeePerGasWei = parseRequiredBigIntFlag(args, "--max-fee-per-gas-wei")
  const maxPriorityFeePerGasWei = parseRequiredBigIntFlag(args, "--max-priority-fee-per-gas-wei")
  const timeoutMs = args.find((value) => value.startsWith("--timeout-ms="))
    ? parseRequiredNumberFlag(args, "--timeout-ms")
    : 120_000

  const rpcUrl = resolveStoryRpcUrl(env) || DEFAULT_STORY_RPC_URL
  const provider = new JsonRpcProvider(rpcUrl, resolveStoryChainId(env))
  try {
    const ownerSigner = new Wallet(ownerPrivateKey, provider)
    const txHashes: string[] = []
    for (let currentNonce = nonce; currentNonce <= endNonce; currentNonce += 1) {
      const tx = await ownerSigner.sendTransaction({
        to: ownerSigner.address,
        value: 0n,
        nonce: currentNonce,
        gasLimit: 21_000,
        maxFeePerGas: maxFeePerGasWei,
        maxPriorityFeePerGas: maxPriorityFeePerGasWei,
      })
      txHashes.push(String(tx.hash || ""))
    }

    await waitForLatestNonce({
      provider,
      address: ownerSigner.address,
      latestRequired: endNonce + 1,
      timeoutMs,
    })
    const latestNonce = await provider.getTransactionCount(ownerSigner.address, "latest")
    const pendingNonce = await provider.getTransactionCount(ownerSigner.address, "pending")
    const ownerBalance = await provider.getBalance(ownerSigner.address)

    console.log(JSON.stringify({
      rpcUrl,
      cancelledNonceStart: nonce,
      cancelledNonceEnd: endNonce,
      txHashes,
      latestNonce,
      pendingNonce,
      ownerBalance: formatEther(ownerBalance),
    }, null, 2))
  } finally {
    void provider.destroy()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
