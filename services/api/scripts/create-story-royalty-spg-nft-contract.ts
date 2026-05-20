import { StoryClient } from "@story-protocol/core-sdk"
import { http, zeroAddress } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import type { Env } from "../src/env"
import { resolveStoryOperatorDirectSigner } from "../src/lib/story/story-direct-signer"
import {
  resolveStoryChainId,
  resolveStoryRpcUrl,
  resolveStoryTxWaitTimeoutMs,
} from "../src/lib/story/story-runtime-config"

type CliOptions = {
  name: string
  symbol: string
  publicMinting: boolean
  force: boolean
}

function usage(exitCode = 1): never {
  console.error([
    "Usage: bun scripts/create-story-royalty-spg-nft-contract.ts [options]",
    "",
    "Options:",
    "  --name <name>          Collection name (default: Pirate Story IP)",
    "  --symbol <symbol>      Collection symbol (default: PIRATEIP)",
    "  --public-minting       Allow public minting. Default is operator-only minting.",
    "  --force                Create even if STORY_ROYALTY_SPG_NFT_CONTRACT is already configured.",
    "  --help                 Show this help.",
  ].join("\n"))
  process.exit(exitCode)
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = {
    name: "Pirate Story IP",
    symbol: "PIRATEIP",
    publicMinting: false,
    force: false,
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--help") usage(0)
    if (arg === "--public-minting") {
      options.publicMinting = true
      continue
    }
    if (arg === "--force") {
      options.force = true
      continue
    }
    if (arg === "--name") {
      options.name = args[index + 1]?.trim() || usage()
      index += 1
      continue
    }
    if (arg === "--symbol") {
      options.symbol = args[index + 1]?.trim() || usage()
      index += 1
      continue
    }
    usage()
  }

  return options
}

function resolveStoryChainName(env: Pick<Env, "STORY_CHAIN_ID">): "aeneid" | "mainnet" {
  return resolveStoryChainId(env) === 1514 ? "mainnet" : "aeneid"
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const env = process.env as Env
  const existingContract = String(env.STORY_ROYALTY_SPG_NFT_CONTRACT || "").trim()

  if (existingContract && !options.force) {
    throw new Error(
      "STORY_ROYALTY_SPG_NFT_CONTRACT is already configured. Re-run with --force only if you intentionally want another collection.",
    )
  }

  const operator = resolveStoryOperatorDirectSigner(env)
  if (!operator.ok) {
    throw new Error(operator.error)
  }
  if (!operator.value) {
    throw new Error("STORY_OPERATOR_PRIVATE_KEY missing/invalid")
  }

  const chainId = resolveStoryChainId(env)
  const rpcUrl = resolveStoryRpcUrl(env)
  const txWaitTimeoutMs = resolveStoryTxWaitTimeoutMs(env)
  const client = StoryClient.newClient({
    account: privateKeyToAccount(operator.value.privateKey as `0x${string}`),
    transport: http(rpcUrl),
    chainId: resolveStoryChainName(env),
  })

  console.log(JSON.stringify({
    status: "creating",
    chain_id: chainId,
    chain_name: resolveStoryChainName(env),
    operator_address: operator.value.address,
    name: options.name,
    symbol: options.symbol,
    public_minting: options.publicMinting,
  }))

  const collection = await client.nftClient.createNFTCollection({
    name: options.name,
    symbol: options.symbol,
    isPublicMinting: options.publicMinting,
    mintOpen: true,
    mintFeeRecipient: zeroAddress,
    contractURI: "",
    owner: operator.value.address,
    txOptions: {
      timeout: txWaitTimeoutMs,
    },
  })

  if (!collection.spgNftContract) {
    throw new Error("Story SDK did not return an SPG NFT contract address")
  }

  console.log(JSON.stringify({
    status: "created",
    chain_id: chainId,
    chain_name: resolveStoryChainName(env),
    tx_hash: collection.txHash,
    spg_nft_contract: collection.spgNftContract,
  }))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
