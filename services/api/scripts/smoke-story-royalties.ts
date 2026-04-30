// @ts-nocheck

import { StoryClient, WIP_TOKEN_ADDRESS } from "@story-protocol/core-sdk"
import type {
  ClaimableRoyaltiesResponse,
  CommunityPurchaseQuote,
  CommunityPurchaseSettlement,
  RoyaltyActivityResponse,
  RoyaltyClaimHistoryResponse,
  RoyaltyClaimRecord,
} from "@pirate/api-contracts"
import { http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import type { Env } from "../src/types"
import { normalizeDirectSignerPrivateKey } from "../src/lib/story/story-direct-signer"
import { resolveStoryChainId, resolveStoryRpcUrl } from "../src/lib/story/story-runtime-config"
import { readDevVarsFromCwd, readWranglerVarsFromCwd } from "./_lib/dev-vars"

type SmokeConfig = {
  apiBaseUrl: string
  creatorAccessToken: string
  buyerAccessToken: string | null
  communityId: string | null
  listingId: string | null
  settlementWalletAttachmentId: string | null
  fundingTxRef: string | null
  settlementTxRef: string | null
  creatorPrivateKey: `0x${string}` | null
  expectedAssetId: string | null
  expectedStoryIpId: string | null
  minClaimableWei: bigint
  pollIntervalMs: number
  pollTimeoutMs: number
  skipPurchase: boolean
  skipClaim: boolean
}

type ApiErrorBody = {
  code?: string
  message?: string
}

function printHelp(): void {
  console.log(`Story royalties smoke script

Usage:
  bun run smoke:story-royalties [--skip-purchase] [--skip-claim]

Required for every run:
  PIRATE_SMOKE_CREATOR_ACCESS_TOKEN       Creator API access token.

Required unless --skip-purchase:
  PIRATE_SMOKE_BUYER_ACCESS_TOKEN         Buyer API access token.
  PIRATE_SMOKE_COMMUNITY_ID               Community containing the listed asset.
  PIRATE_SMOKE_LISTING_ID                 Active listing for a Story-registered asset.
  PIRATE_SMOKE_SETTLEMENT_WALLET_ATTACHMENT_ID
                                         Buyer's primary settlement wallet attachment id.
  PIRATE_SMOKE_FUNDING_TX_REF             Real routed checkout funding tx hash/ref.

Required unless --skip-claim:
  PIRATE_SMOKE_CREATOR_PRIVATE_KEY        Creator wallet private key used to submit the Story claim.

Optional:
  PIRATE_SMOKE_API_BASE_URL               Defaults to http://127.0.0.1:8787.
  PIRATE_SMOKE_SETTLEMENT_TX_REF          Defaults to PIRATE_SMOKE_FUNDING_TX_REF.
  PIRATE_SMOKE_EXPECTED_ASSET_ID          Filters activity/claimable checks to one asset.
  PIRATE_SMOKE_EXPECTED_STORY_IP_ID       Filters claimable checks to one Story IP.
  PIRATE_SMOKE_MIN_CLAIMABLE_WEI          Defaults to 1.
  PIRATE_SMOKE_POLL_INTERVAL_MS           Defaults to 5000.
  PIRATE_SMOKE_POLL_TIMEOUT_MS            Defaults to 180000.
  PIRATE_SMOKE_CHECKOUT_CHAIN_ID          Defaults to 84532.

Examples:
  bun run smoke:story-royalties --skip-purchase --skip-claim
  bun run smoke:story-royalties --skip-purchase
  bun run smoke:story-royalties
`)
}

function readFlag(name: string): string | null {
  const prefix = `${name}=`
  const value = process.argv.slice(2).find((arg) => arg.startsWith(prefix))
  return value ? value.slice(prefix.length).trim() || null : null
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name)
}

function readConfigValue(env: Record<string, string | undefined>, name: string): string | null {
  return readFlag(`--${name.toLowerCase().replaceAll("_", "-")}`) ?? (env[name]?.trim() || null)
}

function readPositiveInt(env: Record<string, string | undefined>, name: string, fallback: number): number {
  const raw = readConfigValue(env, name)
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function readNonNegativeBigInt(env: Record<string, string | undefined>, name: string, fallback: bigint): bigint {
  const raw = readConfigValue(env, name)
  if (!raw) return fallback
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be a wei integer string`)
  }
  return BigInt(raw)
}

function requireConfig(value: string | null, name: string): string {
  if (!value) throw new Error(`${name} is required`)
  return value
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resolveStoryChainName(chainId: number): "aeneid" | "mainnet" {
  return chainId === 1514 ? "mainnet" : "aeneid"
}

function resolveCheckoutChainId(env: Record<string, string | undefined>): number {
  const raw = readConfigValue(env, "PIRATE_SMOKE_CHECKOUT_CHAIN_ID")
    ?? env.VITE_PIRATE_CHECKOUT_SOURCE_CHAIN_ID
    ?? env.VITE_BASE_CHAIN_ID
    ?? ""
  const parsed = raw ? Number(raw) : 84532
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("PIRATE_SMOKE_CHECKOUT_CHAIN_ID must be a positive chain id")
  }
  return parsed
}

function checkoutChainLabel(chainId: number): string {
  if (chainId === 8453) return "Base Mainnet"
  if (chainId === 84532) return "Base Sepolia"
  return `Chain ${chainId}`
}

function resolveConfig(): SmokeConfig {
  const env = {
    ...readWranglerVarsFromCwd("wrangler.jsonc", "development"),
    ...readDevVarsFromCwd(),
    ...process.env,
  } as Record<string, string | undefined>
  const privateKey = normalizeDirectSignerPrivateKey(readConfigValue(env, "PIRATE_SMOKE_CREATOR_PRIVATE_KEY"))
  const skipPurchase = hasFlag("--skip-purchase")
  const skipClaim = hasFlag("--skip-claim")

  return {
    apiBaseUrl: (readConfigValue(env, "PIRATE_SMOKE_API_BASE_URL") ?? "http://127.0.0.1:8787").replace(/\/+$/, ""),
    creatorAccessToken: requireConfig(readConfigValue(env, "PIRATE_SMOKE_CREATOR_ACCESS_TOKEN"), "PIRATE_SMOKE_CREATOR_ACCESS_TOKEN"),
    buyerAccessToken: readConfigValue(env, "PIRATE_SMOKE_BUYER_ACCESS_TOKEN"),
    communityId: readConfigValue(env, "PIRATE_SMOKE_COMMUNITY_ID"),
    listingId: readConfigValue(env, "PIRATE_SMOKE_LISTING_ID"),
    settlementWalletAttachmentId: readConfigValue(env, "PIRATE_SMOKE_SETTLEMENT_WALLET_ATTACHMENT_ID"),
    fundingTxRef: readConfigValue(env, "PIRATE_SMOKE_FUNDING_TX_REF"),
    settlementTxRef: readConfigValue(env, "PIRATE_SMOKE_SETTLEMENT_TX_REF"),
    creatorPrivateKey: privateKey as `0x${string}` | null,
    expectedAssetId: readConfigValue(env, "PIRATE_SMOKE_EXPECTED_ASSET_ID"),
    expectedStoryIpId: readConfigValue(env, "PIRATE_SMOKE_EXPECTED_STORY_IP_ID")?.toLowerCase() ?? null,
    minClaimableWei: readNonNegativeBigInt(env, "PIRATE_SMOKE_MIN_CLAIMABLE_WEI", 1n),
    pollIntervalMs: readPositiveInt(env, "PIRATE_SMOKE_POLL_INTERVAL_MS", 5_000),
    pollTimeoutMs: readPositiveInt(env, "PIRATE_SMOKE_POLL_TIMEOUT_MS", 180_000),
    skipPurchase,
    skipClaim,
  }
}

async function apiRequest<T>(input: {
  baseUrl: string
  path: string
  accessToken: string
  method?: string
  body?: unknown
}): Promise<T> {
  const response = await fetch(`${input.baseUrl}${input.path}`, {
    method: input.method ?? "GET",
    headers: {
      authorization: `Bearer ${input.accessToken}`,
      ...(input.body == null ? {} : { "content-type": "application/json" }),
    },
    body: input.body == null ? undefined : JSON.stringify(input.body),
  })
  if (!response.ok) {
    const text = await response.text()
    let parsed: ApiErrorBody | null = null
    try {
      parsed = JSON.parse(text) as ApiErrorBody
    } catch {
      parsed = null
    }
    throw new Error(`${input.method ?? "GET"} ${input.path} failed: ${response.status} ${parsed?.message ?? text}`)
  }
  return await response.json() as T
}

function sumClaimable(items: ClaimableRoyaltiesResponse["items"]): bigint {
  return items.reduce((total, item) => total + BigInt(item.claimable_wip_wei), 0n)
}

function filterClaimable(input: ClaimableRoyaltiesResponse, config: SmokeConfig): ClaimableRoyaltiesResponse {
  const items = input.items.filter((item) => {
    if (config.expectedAssetId && item.asset_id !== config.expectedAssetId) return false
    if (config.expectedStoryIpId && item.ip_id.toLowerCase() !== config.expectedStoryIpId) return false
    return true
  })
  return {
    ...input,
    items,
    total_claimable_wip_wei: sumClaimable(items).toString(),
  }
}

async function poll<T>(input: {
  label: string
  intervalMs: number
  timeoutMs: number
  check: () => Promise<T | null>
}): Promise<T> {
  const startedAt = Date.now()
  let lastError: unknown = null
  while (Date.now() - startedAt <= input.timeoutMs) {
    try {
      const result = await input.check()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await sleep(input.intervalMs)
  }
  throw new Error(`${input.label} did not become ready within ${input.timeoutMs}ms${lastError instanceof Error ? ` (${lastError.message})` : ""}`)
}

async function createAndSettlePurchase(config: SmokeConfig, checkoutChainId: number): Promise<CommunityPurchaseSettlement> {
  const communityId = requireConfig(config.communityId, "PIRATE_SMOKE_COMMUNITY_ID")
  const listingId = requireConfig(config.listingId, "PIRATE_SMOKE_LISTING_ID")
  const buyerAccessToken = requireConfig(config.buyerAccessToken, "PIRATE_SMOKE_BUYER_ACCESS_TOKEN")
  const settlementWalletAttachmentId = requireConfig(config.settlementWalletAttachmentId, "PIRATE_SMOKE_SETTLEMENT_WALLET_ATTACHMENT_ID")
  const fundingTxRef = requireConfig(config.fundingTxRef, "PIRATE_SMOKE_FUNDING_TX_REF")
  const chainLabel = checkoutChainLabel(checkoutChainId)

  console.log("[smoke] creating purchase quote")
  const quote = await apiRequest<CommunityPurchaseQuote>({
    baseUrl: config.apiBaseUrl,
    path: `/communities/${encodeURIComponent(communityId)}/purchase-quotes`,
    accessToken: buyerAccessToken,
    method: "POST",
    body: {
      listing_id: listingId,
      client_estimated_hop_count: 1,
      client_estimated_slippage_bps: 0,
      funding_asset: {
        asset_symbol: "USDC",
        chain_namespace: "eip155",
        chain_id: checkoutChainId,
        display_name: `USDC on ${chainLabel}`,
      },
      route_provider: "pirate_checkout",
      source_chain: {
        chain_namespace: "eip155",
        chain_id: checkoutChainId,
        display_name: chainLabel,
      },
    },
  })
  console.log(JSON.stringify({
    quote_id: quote.quote_id,
    asset_id: quote.asset_id ?? null,
    final_price_cents: quote.final_price_cents,
    settlement_mode: quote.settlement_mode,
    destination_settlement_amount_atomic: quote.destination_settlement_amount_atomic ?? null,
  }, null, 2))

  console.log("[smoke] settling purchase")
  const settlement = await apiRequest<CommunityPurchaseSettlement>({
    baseUrl: config.apiBaseUrl,
    path: `/communities/${encodeURIComponent(communityId)}/purchase-settlements`,
    accessToken: buyerAccessToken,
    method: "POST",
    body: {
      quote_id: quote.quote_id,
      settlement_wallet_attachment_id: settlementWalletAttachmentId,
      funding_tx_ref: fundingTxRef,
      settlement_tx_ref: config.settlementTxRef ?? fundingTxRef,
    },
  })
  console.log(JSON.stringify({
    purchase_id: settlement.purchase_id,
    asset_id: settlement.asset_id ?? null,
    settlement_mode: settlement.settlement_mode,
    settlement_tx_ref: settlement.settlement_tx_ref,
  }, null, 2))
  return settlement
}

async function pollRoyaltyActivity(config: SmokeConfig, purchaseId: string): Promise<RoyaltyActivityResponse["items"][number]> {
  return await poll({
    label: "royalty activity",
    intervalMs: config.pollIntervalMs,
    timeoutMs: config.pollTimeoutMs,
    check: async () => {
      const activity = await apiRequest<RoyaltyActivityResponse>({
        baseUrl: config.apiBaseUrl,
        path: "/royalties/activity?limit=50",
        accessToken: config.creatorAccessToken,
      })
      return activity.items.find((item) => item.purchase_id === purchaseId) ?? null
    },
  })
}

async function pollClaimable(config: SmokeConfig): Promise<ClaimableRoyaltiesResponse> {
  return await poll({
    label: "claimable royalties",
    intervalMs: config.pollIntervalMs,
    timeoutMs: config.pollTimeoutMs,
    check: async () => {
      const claimable = filterClaimable(await apiRequest<ClaimableRoyaltiesResponse>({
        baseUrl: config.apiBaseUrl,
        path: "/royalties/claimable",
        accessToken: config.creatorAccessToken,
      }), config)
      return BigInt(claimable.total_claimable_wip_wei) >= config.minClaimableWei && claimable.items.length > 0
        ? claimable
        : null
    },
  })
}

async function claimRoyalties(config: SmokeConfig, env: Env, claimable: ClaimableRoyaltiesResponse): Promise<string> {
  if (!config.creatorPrivateKey) {
    throw new Error("PIRATE_SMOKE_CREATOR_PRIVATE_KEY is required unless --skip-claim is set")
  }
  const account = privateKeyToAccount(config.creatorPrivateKey)
  const chainId = resolveStoryChainId(env)
  const storyClient = StoryClient.newClient({
    account,
    transport: http(resolveStoryRpcUrl(env)),
    chainId: resolveStoryChainName(chainId),
  })

  console.log("[smoke] claiming royalties")
  const result = await storyClient.royalty.batchClaimAllRevenue({
    ancestorIps: claimable.items.map((item) => ({
      ipId: item.ip_id as `0x${string}`,
      claimer: item.ip_id as `0x${string}`,
      currencyTokens: [WIP_TOKEN_ADDRESS],
      childIpIds: [] as `0x${string}`[],
      royaltyPolicies: [] as `0x${string}`[],
    })),
    claimOptions: {
      autoTransferAllClaimedTokensFromIp: true,
      autoUnwrapIpTokens: true,
    },
  })
  const txResult = result as unknown as { txHash?: unknown; txHashes?: unknown }
  const txHashes = Array.isArray(txResult.txHashes)
    ? txResult.txHashes as string[]
    : []
  const txHash = typeof txResult.txHash === "string"
    ? txResult.txHash
    : txHashes[0]
  if (!txHash) throw new Error("Story claim returned no tx hash")

  console.log("[smoke] recording claim")
  await apiRequest<RoyaltyClaimRecord>({
    baseUrl: config.apiBaseUrl,
    path: "/royalties/claims",
    accessToken: config.creatorAccessToken,
    method: "POST",
    body: {
      tx_hash: txHash,
      wallet_address: account.address,
      chain_id: chainId,
      claimable_wip_wei_at_submission: claimable.total_claimable_wip_wei,
      ip_ids: claimable.items.map((item) => item.ip_id),
      auto_unwrap_ip_tokens: true,
    },
  })
  return txHash
}

async function pollClaimRecord(config: SmokeConfig, txHash: string): Promise<RoyaltyClaimRecord> {
  return await poll({
    label: "recorded royalty claim",
    intervalMs: config.pollIntervalMs,
    timeoutMs: config.pollTimeoutMs,
    check: async () => {
      const claims = await apiRequest<RoyaltyClaimHistoryResponse>({
        baseUrl: config.apiBaseUrl,
        path: "/royalties/claims?limit=25",
        accessToken: config.creatorAccessToken,
      })
      return claims.items.find((item) => item.tx_hash.toLowerCase() === txHash.toLowerCase()) ?? null
    },
  })
}

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) {
    printHelp()
    return
  }

  const config = resolveConfig()
  const env = {
    ...readWranglerVarsFromCwd("wrangler.jsonc", "development"),
    ...readDevVarsFromCwd(),
    ...process.env,
  } as Env
  const checkoutChainId = resolveCheckoutChainId(process.env)

  console.log(JSON.stringify({
    apiBaseUrl: config.apiBaseUrl,
    storyChainId: resolveStoryChainId(env),
    checkoutChainId,
    skipPurchase: config.skipPurchase,
    skipClaim: config.skipClaim,
    expectedAssetId: config.expectedAssetId,
    expectedStoryIpId: config.expectedStoryIpId,
    pollTimeoutMs: config.pollTimeoutMs,
  }, null, 2))

  let settlement: CommunityPurchaseSettlement | null = null
  if (!config.skipPurchase) {
    settlement = await createAndSettlePurchase(config, checkoutChainId)
    const activity = await pollRoyaltyActivity(config, settlement.purchase_id)
    console.log("[smoke] royalty activity found")
    console.log(JSON.stringify({
      event_id: activity.event_id,
      amount_wip_wei: activity.amount_wip_wei,
      asset_id: activity.asset_id,
      purchase_id: activity.purchase_id,
      story_ip_id: activity.story_ip_id,
      title: activity.title,
      tx_hash: activity.tx_hash,
    }, null, 2))
  }

  const claimable = await pollClaimable(config)
  console.log("[smoke] claimable royalties found")
  console.log(JSON.stringify({
    total_claimable_wip_wei: claimable.total_claimable_wip_wei,
    item_count: claimable.items.length,
    items: claimable.items.map((item) => ({
      asset_id: item.asset_id,
      claimable_wip_wei: item.claimable_wip_wei,
      ip_id: item.ip_id,
      title: item.title,
    })),
  }, null, 2))

  if (config.skipClaim) {
    console.log("[smoke] --skip-claim set; not submitting claim tx")
    return
  }

  const claimTxHash = await claimRoyalties(config, env, claimable)
  const claimRecord = await pollClaimRecord(config, claimTxHash)
  console.log("[smoke] claim recorded")
  console.log(JSON.stringify({
    claim_id: claimRecord.claim_id,
    tx_hash: claimRecord.tx_hash,
    status: claimRecord.status,
    verified_at: claimRecord.verified_at,
  }, null, 2))

  const afterClaimable = filterClaimable(await apiRequest<ClaimableRoyaltiesResponse>({
    baseUrl: config.apiBaseUrl,
    path: "/royalties/claimable",
    accessToken: config.creatorAccessToken,
  }), config)
  console.log("[smoke] post-claim claimable")
  console.log(JSON.stringify({
    total_claimable_wip_wei: afterClaimable.total_claimable_wip_wei,
    item_count: afterClaimable.items.length,
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
