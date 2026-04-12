import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { privateKeyToAccount } from "viem/accounts"
import type { Asset, Env } from "../../types"
import { getStoryAeneidDeliveryDefaults } from "../posts/story-delivery-config"

const DEFAULT_IPFS_GATEWAY_URL = "https://psc.myfilebase.com/ipfs"
const DEFAULT_LIT_CHIPOTLE_API_BASE_URL = "https://api.dev.litprotocol.com"
const DEFAULT_STORY_AENEID_RPC_URL = "https://rpc.ankr.com/story_aeneid_testnet"
const DEFAULT_STORY_SETTLEMENT_PKP_ADDRESS = "0xfB1E0bbE209C1B75f8E365F3055bfF4b0a24702B"
const SETTLE_PURCHASE_SELECTOR = "0x187c706a"
const SETTLED_PURCHASES_SELECTOR = "0x901259ca"

function maybe(value: string | null | undefined): string | null {
  const trimmed = String(value || "").trim()
  return trimmed || null
}

function requireAddress(value: string | null | undefined, label: string): string {
  const normalized = String(value || "").trim()
  if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) {
    throw new Error(`${label}_invalid`)
  }
  return normalized
}

function requireBytes32(value: string | null | undefined, label: string): string {
  const normalized = String(value || "").trim()
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new Error(`${label}_invalid`)
  }
  return normalized.toLowerCase()
}

function requireUintString(value: string | null | undefined, label: string): string {
  const normalized = String(value || "").trim()
  if (!/^[1-9]\d*$/.test(normalized)) {
    throw new Error(`${label}_invalid`)
  }
  return normalized
}

function requirePrivateKey(value: string | null | undefined, label: string): `0x${string}` {
  const normalized = String(value || "").trim()
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new Error(`${label}_invalid`)
  }
  return normalized as `0x${string}`
}

function encodeAddressWord(value: string): string {
  return requireAddress(value, "address_word").toLowerCase().replace(/^0x/, "").padStart(64, "0")
}

function encodeBytes32Word(value: string): string {
  return requireBytes32(value, "bytes32_word").replace(/^0x/, "")
}

function encodeUintWord(value: bigint): string {
  if (value < 0n) {
    throw new Error("uint_value_invalid")
  }
  return value.toString(16).padStart(64, "0")
}

function decodeUintWord(word: string): bigint {
  const normalized = word.replace(/^0x/, "")
  if (!/^[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new Error("uint_word_invalid")
  }
  return BigInt(`0x${normalized}`)
}

function decodeBoolResult(value: unknown): boolean {
  const normalized = String(value || "").trim().replace(/^0x/, "")
  if (normalized.length !== 64) {
    throw new Error("bool_result_invalid")
  }
  return decodeUintWord(normalized) !== 0n
}

function buildSettlePurchaseCalldata(input: {
  purchaseRef: string
  buyer: string
  tokenId: bigint
  payoutRecipient: string
}): string {
  return `0x${SETTLE_PURCHASE_SELECTOR.slice(2)}${[
    encodeBytes32Word(input.purchaseRef),
    encodeAddressWord(input.buyer),
    encodeUintWord(input.tokenId),
    encodeAddressWord(input.payoutRecipient),
  ].join("")}`
}

function buildSettledPurchasesCalldata(purchaseRef: string): string {
  return `0x${SETTLED_PURCHASES_SELECTOR.slice(2)}${encodeBytes32Word(purchaseRef)}`
}

function readLocalActionSource(): string {
  return readFileSync(
    new URL("../../../../../lit-actions/story-settlement/settle-purchase.js", import.meta.url),
    "utf8",
  )
}

async function fetchTextFromIpfs(ref: string, env: Env): Promise<string> {
  const normalizedRef = String(ref || "").trim()
  if (!normalizedRef.startsWith("ipfs://")) {
    throw new Error("lit_action_ref_invalid")
  }
  const gatewayBase = String(env.IPFS_GATEWAY_URL || DEFAULT_IPFS_GATEWAY_URL).trim().replace(/\/+$/, "")
  const response = await fetch(`${gatewayBase}/${normalizedRef.slice("ipfs://".length)}`)
  if (!response.ok) {
    throw new Error(`lit_action_fetch_failed:${response.status}`)
  }
  return await response.text()
}

async function litApiRequest(input: {
  baseUrl: string
  apiKey: string
  body: unknown
}): Promise<unknown> {
  const response = await fetch(`${input.baseUrl.replace(/\/+$/, "")}/core/v1/lit_action`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": input.apiKey,
    },
    body: JSON.stringify(input.body),
  })
  const raw = await response.text()
  if (!response.ok) {
    throw new Error(`lit_api_http_error:${response.status}:${raw.slice(0, 500)}`)
  }
  return raw ? JSON.parse(raw) : null
}

async function rpcRequest(input: {
  rpcUrl: string
  method: string
  params: unknown[]
}): Promise<unknown> {
  const response = await fetch(input.rpcUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: input.method,
      params: input.params,
    }),
  })
  const payload = await response.json() as { result?: unknown; error?: { message?: string } }
  if (!response.ok || payload.error) {
    throw new Error(`story_rpc_error:${input.method}:${payload.error?.message || response.status}`)
  }
  return payload.result
}

async function waitForReceipt(rpcUrl: string, txHash: string): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const receipt = await rpcRequest({
      rpcUrl,
      method: "eth_getTransactionReceipt",
      params: [txHash],
    }) as { status?: string } | null
    if (receipt?.status) {
      if (receipt.status !== "0x1") {
        throw new Error(`story_settlement_tx_reverted:${txHash}`)
      }
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`story_settlement_receipt_timeout:${txHash}`)
}

async function fetchNonce(rpcUrl: string, account: string): Promise<number> {
  const result = String(await rpcRequest({
    rpcUrl,
    method: "eth_getTransactionCount",
    params: [account, "pending"],
  }) || "").trim()
  if (!/^0x[a-fA-F0-9]+$/.test(result)) {
    throw new Error("story_settlement_nonce_invalid")
  }
  return Number(BigInt(result))
}

export function hasStorySettlementDirectKeyConfigured(env: Env): boolean {
  return Boolean(maybe(env.STORY_SETTLEMENT_PRIVATE_KEY))
}

export function buildStoryPurchaseRef(input: {
  communityId: string
  quoteId: string
}): string {
  return `0x${createHash("sha256").update(`community-purchase:${input.communityId}:${input.quoteId}`).digest("hex")}`
}

export async function isStoryPurchaseSettled(input: {
  env: Env
  purchaseRef: string
}): Promise<boolean> {
  const defaults = getStoryAeneidDeliveryDefaults()
  const rpcUrl = maybe(input.env.STORY_AENEID_RPC_URL) || defaults.rpcUrl || DEFAULT_STORY_AENEID_RPC_URL
  const settlementAddress = requireAddress(
    maybe(input.env.STORY_MARKETPLACE_SETTLEMENT_ADDRESS) || defaults.marketplaceSettlementV1,
    "story_marketplace_settlement_address",
  )
  const result = await rpcRequest({
    rpcUrl,
    method: "eth_call",
    params: [
      {
        to: settlementAddress,
        data: buildSettledPurchasesCalldata(input.purchaseRef),
      },
      "latest",
    ],
  })
  return decodeBoolResult(result)
}

export async function settleCommunityPurchaseViaLit(input: {
  env: Env
  communityId: string
  quoteId: string
  asset: Asset
  buyerAddress: string
  payoutRecipient: string
  amountAtomic: string
}): Promise<{
  purchaseRef: string
  storySettlementTxRef: string
}> {
  const usageApiKey = maybe(input.env.LIT_CHIPOTLE_STORY_SETTLEMENT_API_KEY)
  if (!usageApiKey) {
    throw new Error("lit_chipotle_story_settlement_api_key_missing")
  }

  const tokenId = BigInt(String(input.asset.story_entitlement_token_id || "0"))
  if (tokenId <= 0n) {
    throw new Error("story_entitlement_token_id_missing")
  }

  const defaults = getStoryAeneidDeliveryDefaults()
  const rpcUrl = maybe(input.env.STORY_AENEID_RPC_URL) || defaults.rpcUrl || DEFAULT_STORY_AENEID_RPC_URL
  const settlementAddress = requireAddress(
    maybe(input.env.STORY_MARKETPLACE_SETTLEMENT_ADDRESS) || defaults.marketplaceSettlementV1,
    "story_marketplace_settlement_address",
  )
  const expectedSigner = requireAddress(
    maybe(input.env.STORY_SETTLEMENT_PKP_ADDRESS) || defaults.settlementOperator || DEFAULT_STORY_SETTLEMENT_PKP_ADDRESS,
    "story_settlement_pkp_address",
  ).toLowerCase()
  const litBaseUrl = (maybe(input.env.LIT_CHIPOTLE_API_BASE_URL) || DEFAULT_LIT_CHIPOTLE_API_BASE_URL).replace(/\/+$/, "")
  const actionSource = maybe(input.env.STORY_SETTLEMENT_SETTLE_PURCHASE_ACTION_CID)
    ? await fetchTextFromIpfs(String(input.env.STORY_SETTLEMENT_SETTLE_PURCHASE_ACTION_CID), input.env)
    : readLocalActionSource()

  const purchaseRef = buildStoryPurchaseRef({
    communityId: input.communityId,
    quoteId: input.quoteId,
  })
  const buyerAddress = requireAddress(input.buyerAddress, "buyer_address")
  const payoutRecipient = requireAddress(input.payoutRecipient, "payout_recipient")
  const value = requireUintString(input.amountAtomic, "settlement_amount_atomic")

  const alreadySettled = await isStoryPurchaseSettled({
    env: input.env,
    purchaseRef,
  })
  if (alreadySettled) {
    throw new Error("story_purchase_already_settled")
  }

  const nonce = await fetchNonce(rpcUrl, expectedSigner)
  const execution = await litApiRequest({
    baseUrl: litBaseUrl,
    apiKey: usageApiKey,
    body: {
      code: actionSource,
      js_params: {
        unsignedTx: {
          type: 2,
          chainId: 1315,
          nonce,
          to: settlementAddress,
          value,
          data: buildSettlePurchaseCalldata({
            purchaseRef,
            buyer: buyerAddress,
            tokenId,
            payoutRecipient,
          }),
          gasLimit: "250000",
          maxFeePerGas: "1000000000",
          maxPriorityFeePerGas: "100000000",
        },
        expectedSignerAddress: expectedSigner,
      },
    },
  }) as { response?: string | { signerAddress?: string; serializedTx?: string } }

  const payload = typeof execution.response === "string"
    ? JSON.parse(execution.response)
    : execution.response
  const signerAddress = String(payload?.signerAddress || "").toLowerCase()
  if (signerAddress !== expectedSigner) {
    throw new Error(`lit_action_signer_mismatch:${JSON.stringify({ actual: signerAddress, expected: expectedSigner })}`)
  }
  const serializedTx = String(payload?.serializedTx || "").trim()
  if (!serializedTx.startsWith("0x")) {
    throw new Error("lit_action_missing_serialized_tx")
  }

  const txHash = String(await rpcRequest({
    rpcUrl,
    method: "eth_sendRawTransaction",
    params: [serializedTx],
  }) || "").trim()
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    throw new Error("story_settlement_tx_hash_invalid")
  }
  await waitForReceipt(rpcUrl, txHash)

  return {
    purchaseRef,
    storySettlementTxRef: txHash,
  }
}

export async function settleCommunityPurchaseViaDirectKey(input: {
  env: Env
  communityId: string
  quoteId: string
  asset: Asset
  buyerAddress: string
  payoutRecipient: string
  amountAtomic: string
}): Promise<{
  purchaseRef: string
  storySettlementTxRef: string
}> {
  const privateKey = requirePrivateKey(input.env.STORY_SETTLEMENT_PRIVATE_KEY, "story_settlement_private_key")
  const tokenId = BigInt(String(input.asset.story_entitlement_token_id || "0"))
  if (tokenId <= 0n) {
    throw new Error("story_entitlement_token_id_missing")
  }

  const defaults = getStoryAeneidDeliveryDefaults()
  const rpcUrl = maybe(input.env.STORY_AENEID_RPC_URL) || defaults.rpcUrl || DEFAULT_STORY_AENEID_RPC_URL
  const settlementAddress = requireAddress(
    maybe(input.env.STORY_MARKETPLACE_SETTLEMENT_ADDRESS) || defaults.marketplaceSettlementV1,
    "story_marketplace_settlement_address",
  )
  const purchaseRef = buildStoryPurchaseRef({
    communityId: input.communityId,
    quoteId: input.quoteId,
  })
  const buyerAddress = requireAddress(input.buyerAddress, "buyer_address")
  const payoutRecipient = requireAddress(input.payoutRecipient, "payout_recipient")
  const value = BigInt(requireUintString(input.amountAtomic, "settlement_amount_atomic"))

  const alreadySettled = await isStoryPurchaseSettled({
    env: input.env,
    purchaseRef,
  })
  if (alreadySettled) {
    throw new Error("story_purchase_already_settled")
  }

  const account = privateKeyToAccount(privateKey)
  const nonce = await fetchNonce(rpcUrl, account.address)
  const serializedTx = await account.signTransaction({
    type: "eip1559",
    chainId: 1315,
    nonce,
    to: settlementAddress as `0x${string}`,
    value,
    data: buildSettlePurchaseCalldata({
      purchaseRef,
      buyer: buyerAddress,
      tokenId,
      payoutRecipient,
    }) as `0x${string}`,
    gas: 250000n,
    maxFeePerGas: 1000000000n,
    maxPriorityFeePerGas: 100000000n,
  })
  const txHash = String(await rpcRequest({
    rpcUrl,
    method: "eth_sendRawTransaction",
    params: [serializedTx],
  }) || "").trim()
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    throw new Error("story_settlement_tx_hash_invalid")
  }
  await waitForReceipt(rpcUrl, txHash)

  return {
    purchaseRef,
    storySettlementTxRef: txHash,
  }
}
