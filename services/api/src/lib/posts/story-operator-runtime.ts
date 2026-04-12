import { readFileSync } from "node:fs"
import { createPublicClient, createWalletClient, decodeFunctionResult, encodeFunctionData, http, parseAbi } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import type { Asset, Env } from "../../types"
import { getStoryAeneidDeliveryDefaults } from "./story-delivery-config"

const DEFAULT_IPFS_GATEWAY_URL = "https://psc.myfilebase.com/ipfs"
const DEFAULT_LIT_CHIPOTLE_API_BASE_URL = "https://api.dev.litprotocol.com"
const DEFAULT_STORY_AENEID_RPC_URL = "https://rpc.ankr.com/story_aeneid_testnet"
const DEFAULT_STORY_IP_ASSET_REGISTRY_ADDRESS = "0x77319B4031e6eF1250907aa00018B8B1c67a244b"
const DEFAULT_STORY_OPERATOR_PKP_ADDRESS = "0x7f969455cFe240927F1ACe4E23000685Ad224dA7"
const ENTITLEMENT_CLASSES_SELECTOR = "0xc16e8b38"
const STORY_CHAIN_ID = 1315n
const STORY_PUBLISH_GAS_LIMIT = 300000n
const STORY_GAS_PRICE = 1_000_000_000n
const SONG_IP_TOKEN_ABI = parseAbi([
  "function mint(address to, uint256 tokenId)",
])
const IP_ASSET_REGISTRY_ABI = parseAbi([
  "function register(uint256 chainId, address tokenContract, uint256 tokenId) returns (address ipId)",
  "function ipId(uint256 chainId, address tokenContract, uint256 tokenId) view returns (address)",
])

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

function requirePrivateKey(value: string | null | undefined, label: string): `0x${string}` {
  const normalized = String(value || "").trim()
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new Error(`${label}_invalid`)
  }
  return normalized as `0x${string}`
}

function encodeUintWord(value: bigint): string {
  if (value <= 0n) {
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

function readLocalActionSource(): string {
  return readFileSync(
    new URL("../../../../../../lit-actions/story-operator/bundled/publish-asset-version.bundle.js", import.meta.url),
    "utf8",
  )
}

async function litApiRequest(input: {
  baseUrl: string
  path: string
  apiKey: string
  body: unknown
}): Promise<unknown> {
  const response = await fetch(`${input.baseUrl.replace(/\/+$/, "")}${input.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": input.apiKey,
    },
    body: JSON.stringify(input.body),
  })
  const raw = await response.text()
  if (!response.ok) {
    throw new Error(`lit_api_http_error:${input.path}:${response.status}:${raw.slice(0, 500)}`)
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

async function fetchNonce(rpcUrl: string, account: string): Promise<number> {
  const result = String(await rpcRequest({
    rpcUrl,
    method: "eth_getTransactionCount",
    params: [account, "pending"],
  }) || "").trim()
  if (!/^0x[a-fA-F0-9]+$/.test(result)) {
    throw new Error("story_publish_nonce_invalid")
  }
  return Number(BigInt(result))
}

function parseEntitlementClassResult(value: unknown): {
  assetVersionId: string
  cdrVaultUuid: bigint
  active: boolean
  exists: boolean
} {
  const normalized = String(value || "").trim().replace(/^0x/, "")
  if (normalized.length !== 64 * 4) {
    throw new Error("story_entitlement_class_result_invalid")
  }
  const assetVersionId = `0x${normalized.slice(0, 64)}`.toLowerCase()
  const cdrVaultUuid = decodeUintWord(normalized.slice(64, 128))
  const active = decodeUintWord(normalized.slice(128, 192)) !== 0n
  const exists = decodeUintWord(normalized.slice(192, 256)) !== 0n
  return {
    assetVersionId,
    cdrVaultUuid,
    active,
    exists,
  }
}

async function verifyEntitlementClassConfigured(input: {
  rpcUrl: string
  entitlementTokenAddress: string
  assetVersionId: string
  cdrVaultUuid: bigint
  entitlementTokenId: bigint
}): Promise<void> {
  const result = await rpcRequest({
    rpcUrl: input.rpcUrl,
    method: "eth_call",
    params: [
      {
        to: input.entitlementTokenAddress,
        data: `0x${ENTITLEMENT_CLASSES_SELECTOR.slice(2)}${encodeUintWord(input.entitlementTokenId)}`,
      },
      "latest",
    ],
  })
  const parsed = parseEntitlementClassResult(result)
  if (!parsed.exists) {
    throw new Error("story_entitlement_class_not_configured")
  }
  if (parsed.assetVersionId !== input.assetVersionId || parsed.cdrVaultUuid !== input.cdrVaultUuid) {
    throw new Error("story_entitlement_class_mismatch")
  }
  if (!parsed.active) {
    throw new Error("story_entitlement_class_inactive")
  }
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
        throw new Error(`story_publish_tx_reverted:${txHash}`)
      }
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`story_publish_receipt_timeout:${txHash}`)
}

function buildSongIpTokenId(assetVersionId: string): bigint {
  const tokenId = BigInt(assetVersionId)
  if (tokenId <= 0n) {
    throw new Error("story_ip_nft_token_id_invalid")
  }
  return tokenId
}

function buildMintSongIpTokenCalldata(input: {
  publisher: string
  tokenId: bigint
}): `0x${string}` {
  return encodeFunctionData({
    abi: SONG_IP_TOKEN_ABI,
    functionName: "mint",
    args: [input.publisher as `0x${string}`, input.tokenId],
  })
}

function buildRegisterIpCalldata(input: {
  tokenContract: string
  tokenId: bigint
}): `0x${string}` {
  return encodeFunctionData({
    abi: IP_ASSET_REGISTRY_ABI,
    functionName: "register",
    args: [STORY_CHAIN_ID, input.tokenContract as `0x${string}`, input.tokenId],
  })
}

async function resolveStoryIpId(input: {
  rpcUrl: string
  ipAssetRegistryAddress: string
  tokenContract: string
  tokenId: bigint
}): Promise<string> {
  const result = await rpcRequest({
    rpcUrl: input.rpcUrl,
    method: "eth_call",
    params: [
      {
        to: input.ipAssetRegistryAddress,
        data: encodeFunctionData({
          abi: IP_ASSET_REGISTRY_ABI,
          functionName: "ipId",
          args: [STORY_CHAIN_ID, input.tokenContract as `0x${string}`, input.tokenId],
        }),
      },
      "latest",
    ],
  })
  return decodeFunctionResult({
    abi: IP_ASSET_REGISTRY_ABI,
    functionName: "ipId",
    data: String(result || "") as `0x${string}`,
  })
}

async function verifyStoryPublishInputs(input: {
  env: Env
  defaults: ReturnType<typeof getStoryAeneidDeliveryDefaults>
  asset: Asset
  rpcUrl: string
}): Promise<void> {
  const entitlementTokenAddress = requireAddress(
    maybe(input.env.STORY_ENTITLEMENT_TOKEN_ADDRESS) || input.defaults.purchaseEntitlementToken,
    "story_entitlement_token_address",
  )
  const assetVersionId = requireBytes32(input.asset.story_asset_version_id, "story_asset_version_id")
  const cdrVaultUuid = BigInt(Number(input.asset.story_cdr_vault_uuid ?? 0))
  if (cdrVaultUuid <= 0n) {
    throw new Error("story_cdr_vault_uuid_missing")
  }
  const entitlementTokenId = BigInt(String(input.asset.story_entitlement_token_id || "0"))
  if (entitlementTokenId <= 0n) {
    throw new Error("story_entitlement_token_id_missing")
  }
  requireAddress(input.asset.story_read_condition, "story_read_condition")
  requireAddress(input.asset.story_write_condition, "story_write_condition")

  await verifyEntitlementClassConfigured({
    rpcUrl: input.rpcUrl,
    entitlementTokenAddress,
    assetVersionId,
    cdrVaultUuid,
    entitlementTokenId,
  })
}

async function signUnsignedTxViaLit(input: {
  apiKey: string
  litActionCode: string
  litBaseUrl: string
  expectedSigner: string
  unsignedTx: {
    type: 2
    chainId: number
    nonce: number
    to: string
    value: string
    data: `0x${string}`
    gasLimit: string
    maxFeePerGas: string
    maxPriorityFeePerGas: string
  }
}): Promise<string> {
  const execution = await litApiRequest({
    baseUrl: input.litBaseUrl,
    path: "/core/v1/lit_action",
    apiKey: input.apiKey,
    body: {
      code: input.litActionCode,
      js_params: {
        unsignedTx: input.unsignedTx,
      },
    },
  }) as { response?: string | { signerAddress?: string; serializedTx?: string } }

  const payload = typeof execution.response === "string"
    ? JSON.parse(execution.response)
    : execution.response
  const signerAddress = String(payload?.signerAddress || "").toLowerCase()
  if (signerAddress !== input.expectedSigner) {
    throw new Error(`lit_action_signer_mismatch:${JSON.stringify({ actual: signerAddress, expected: input.expectedSigner })}`)
  }
  const serializedTx = String(payload?.serializedTx || "").trim()
  if (!serializedTx.startsWith("0x")) {
    throw new Error("lit_action_missing_serialized_tx")
  }
  return serializedTx
}

async function sendSignedTransaction(rpcUrl: string, serializedTx: string): Promise<string> {
  const txHash = String(await rpcRequest({
    rpcUrl,
    method: "eth_sendRawTransaction",
    params: [serializedTx],
  }) || "").trim()
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    throw new Error("story_publish_tx_hash_invalid")
  }
  await waitForReceipt(rpcUrl, txHash)
  return txHash
}

export async function publishSongAssetVersionViaLit(input: {
  env: Env
  asset: Asset
  publisherAddress: string
}): Promise<{
  storyIpId: string
  storyIpNftContract: string
  storyIpNftTokenId: string
  storyPublishTxRef: string
  storyPublishModel: "story_ip_v1"
}> {
  const usageApiKey = maybe(input.env.LIT_CHIPOTLE_OPERATOR_API_KEY)
  if (!usageApiKey) {
    throw new Error("lit_chipotle_operator_api_key_missing")
  }

  const assetVersionId = requireBytes32(input.asset.story_asset_version_id, "story_asset_version_id")
  const songIpTokenId = buildSongIpTokenId(assetVersionId)
  const publisher = requireAddress(input.publisherAddress, "publisher_address")
  const litActionCode = maybe(input.env.STORY_OPERATOR_PUBLISH_ASSET_VERSION_ACTION_CID)
    ? await fetchTextFromIpfs(String(input.env.STORY_OPERATOR_PUBLISH_ASSET_VERSION_ACTION_CID), input.env)
    : readLocalActionSource()
  const litBaseUrl = (maybe(input.env.LIT_CHIPOTLE_API_BASE_URL) || DEFAULT_LIT_CHIPOTLE_API_BASE_URL).replace(/\/+$/, "")
  const defaults = getStoryAeneidDeliveryDefaults()
  const rpcUrl = maybe(input.env.STORY_AENEID_RPC_URL) || defaults.rpcUrl || DEFAULT_STORY_AENEID_RPC_URL
  const expectedSigner = (
    maybe(input.env.STORY_OPERATOR_PKP_ADDRESS)
    || defaults.publishOperator
    || DEFAULT_STORY_OPERATOR_PKP_ADDRESS
  ).toLowerCase()
  await verifyStoryPublishInputs({
    env: input.env,
    defaults,
    asset: input.asset,
    rpcUrl,
  })
  const songIpTokenAddress = requireAddress(
    maybe(input.env.STORY_SONG_IP_TOKEN_ADDRESS) || defaults.songIpTokenV1,
    "story_song_ip_token_address",
  )
  const ipAssetRegistryAddress = requireAddress(
    maybe(input.env.STORY_IP_ASSET_REGISTRY_ADDRESS) || DEFAULT_STORY_IP_ASSET_REGISTRY_ADDRESS,
    "story_ip_asset_registry_address",
  )
  const mintNonce = await fetchNonce(rpcUrl, expectedSigner)

  const mintSerializedTx = await signUnsignedTxViaLit({
    apiKey: usageApiKey,
    litActionCode,
    litBaseUrl,
    expectedSigner,
    unsignedTx: {
      type: 2,
      chainId: Number(STORY_CHAIN_ID),
      nonce: mintNonce,
      to: songIpTokenAddress,
      value: "0",
      data: buildMintSongIpTokenCalldata({
        publisher,
        tokenId: songIpTokenId,
      }),
      gasLimit: String(STORY_PUBLISH_GAS_LIMIT),
      maxFeePerGas: String(STORY_GAS_PRICE),
      maxPriorityFeePerGas: "100000000",
    },
  })
  await sendSignedTransaction(rpcUrl, mintSerializedTx)
  const registerNonce = await fetchNonce(rpcUrl, expectedSigner)

  const registerSerializedTx = await signUnsignedTxViaLit({
    apiKey: usageApiKey,
    litActionCode,
    litBaseUrl,
    expectedSigner,
    unsignedTx: {
      type: 2,
      chainId: Number(STORY_CHAIN_ID),
      nonce: registerNonce,
      to: ipAssetRegistryAddress,
      value: "0",
      data: buildRegisterIpCalldata({
        tokenContract: songIpTokenAddress,
        tokenId: songIpTokenId,
      }),
      gasLimit: String(STORY_PUBLISH_GAS_LIMIT),
      maxFeePerGas: String(STORY_GAS_PRICE),
      maxPriorityFeePerGas: "100000000",
    },
  })
  const registerTxHash = await sendSignedTransaction(rpcUrl, registerSerializedTx)
  const storyIpId = await resolveStoryIpId({
    rpcUrl,
    ipAssetRegistryAddress,
    tokenContract: songIpTokenAddress,
    tokenId: songIpTokenId,
  })

  return {
    storyIpId,
    storyIpNftContract: songIpTokenAddress,
    storyIpNftTokenId: songIpTokenId.toString(),
    storyPublishTxRef: registerTxHash,
    storyPublishModel: "story_ip_v1",
  }
}

export function hasStoryPublishDirectKeyConfigured(env: Env): boolean {
  return Boolean(maybe(env.STORY_PUBLISH_OPERATOR_PRIVATE_KEY))
}

export async function publishSongAssetVersionViaDirectKey(input: {
  env: Env
  asset: Asset
  publisherAddress: string
}): Promise<{
  storyIpId: string
  storyIpNftContract: string
  storyIpNftTokenId: string
  storyPublishTxRef: string
  storyPublishModel: "story_ip_v1"
}> {
  const privateKey = requirePrivateKey(input.env.STORY_PUBLISH_OPERATOR_PRIVATE_KEY, "story_publish_operator_private_key")
  const defaults = getStoryAeneidDeliveryDefaults()
  const rpcUrl = maybe(input.env.STORY_AENEID_RPC_URL) || defaults.rpcUrl || DEFAULT_STORY_AENEID_RPC_URL
  await verifyStoryPublishInputs({
    env: input.env,
    defaults,
    asset: input.asset,
    rpcUrl,
  })
  const songIpTokenAddress = requireAddress(
    maybe(input.env.STORY_SONG_IP_TOKEN_ADDRESS) || defaults.songIpTokenV1,
    "story_song_ip_token_address",
  )
  const ipAssetRegistryAddress = requireAddress(
    maybe(input.env.STORY_IP_ASSET_REGISTRY_ADDRESS) || DEFAULT_STORY_IP_ASSET_REGISTRY_ADDRESS,
    "story_ip_asset_registry_address",
  )
  const publisher = requireAddress(input.publisherAddress, "publisher_address")
  const assetVersionId = requireBytes32(input.asset.story_asset_version_id, "story_asset_version_id")
  const songIpTokenId = buildSongIpTokenId(assetVersionId)

  const account = privateKeyToAccount(privateKey)
  const publicClient = createPublicClient({
    transport: http(rpcUrl),
  })
  const walletClient = createWalletClient({
    account,
    transport: http(rpcUrl),
  })
  const mintTxHash = await walletClient.sendTransaction({
    account,
    chain: null,
    to: songIpTokenAddress as `0x${string}`,
    data: buildMintSongIpTokenCalldata({
      publisher,
      tokenId: songIpTokenId,
    }),
    gas: STORY_PUBLISH_GAS_LIMIT,
    gasPrice: STORY_GAS_PRICE,
  })
  await publicClient.waitForTransactionReceipt({ hash: mintTxHash })

  const registerTxHash = await walletClient.sendTransaction({
    account,
    chain: null,
    to: ipAssetRegistryAddress as `0x${string}`,
    data: buildRegisterIpCalldata({
      tokenContract: songIpTokenAddress,
      tokenId: songIpTokenId,
    }),
    gas: STORY_PUBLISH_GAS_LIMIT,
    gasPrice: STORY_GAS_PRICE,
  })
  await publicClient.waitForTransactionReceipt({ hash: registerTxHash })

  const storyIpId = await resolveStoryIpId({
    rpcUrl,
    ipAssetRegistryAddress,
    tokenContract: songIpTokenAddress,
    tokenId: songIpTokenId,
  })
  return {
    storyIpId,
    storyIpNftContract: songIpTokenAddress,
    storyIpNftTokenId: songIpTokenId.toString(),
    storyPublishTxRef: registerTxHash,
    storyPublishModel: "story_ip_v1",
  }
}
