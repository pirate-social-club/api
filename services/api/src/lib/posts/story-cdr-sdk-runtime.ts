import { TextEncoder } from "node:util"
import { createPublicClient, createWalletClient, encodeAbiParameters, http, parseEventLogs, toHex } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { encryptFile } from "@piplabs/cdr-crypto"
import { cdrAbi, contractAddresses } from "@piplabs/cdr-contracts"
import type { Asset, Env } from "../../types"
import { persistSongArtifactUpload } from "./local-song-artifact-upload-storage"
import { readStoredSongArtifactBytes } from "./song-artifact-storage"
import { CDRClient, initWasm, type StorageProvider } from "./story-cdr-sdk-client"
import { getStoryAeneidDeliveryDefaults } from "./story-delivery-config"

const DEFAULT_STORY_AENEID_RPC_URL = "https://rpc.ankr.com/story_aeneid_testnet"
const DEFAULT_IPFS_GATEWAY_URL = "https://psc.myfilebase.com/ipfs"
const DEFAULT_CDR_TX_GAS_PRICE = 10_000_000_000n
const DEFAULT_CDR_ALLOCATE_GAS = 400_000n
const DEFAULT_CDR_WRITE_GAS = 700_000n

let wasmInitPromise: Promise<void> | null = null

function maybe(value: string | null | undefined): string | null {
  const trimmed = String(value || "").trim()
  return trimmed || null
}

function requireAddress(value: string | null | undefined, label: string): `0x${string}` {
  const normalized = String(value || "").trim()
  if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) {
    throw new Error(`${label}_invalid`)
  }
  return normalized as `0x${string}`
}

function requireBytes32(value: string | null | undefined, label: string): `0x${string}` {
  const normalized = String(value || "").trim()
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new Error(`${label}_invalid`)
  }
  return normalized.toLowerCase() as `0x${string}`
}

function requirePrivateKey(value: string | null | undefined, label: string): `0x${string}` {
  const normalized = String(value || "").trim()
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new Error(`${label}_invalid`)
  }
  return normalized as `0x${string}`
}

function requireNonEmptyString(value: string | null | undefined, label: string): string {
  const normalized = String(value || "").trim()
  if (!normalized) {
    throw new Error(`${label}_missing`)
  }
  return normalized
}

function resolveCdrDkgConfig(env: Env): {
  dkgSource: "evm-events" | "cosmos-abci"
  cometRpcUrl?: string
} {
  const cometRpcUrl = maybe(env.STORY_CDR_COMET_RPC_URL)
  if (cometRpcUrl) {
    return {
      dkgSource: "cosmos-abci",
      cometRpcUrl,
    }
  }
  return {
    dkgSource: "evm-events",
  }
}

function buildReadConditionData(input: {
  asset: Asset
  env: Env
  storyEntitlementTokenId: string
  storyReadCondition: `0x${string}`
}): `0x${string}` {
  const configured = maybe(input.env.STORY_CDR_READ_CONDITION_DATA)
  if (configured) {
    if (!/^0x[a-fA-F0-9]*$/.test(configured) || configured.length % 2 !== 0) {
      throw new Error("story_cdr_read_condition_data_invalid")
    }
    return configured as `0x${string}`
  }
  const defaults = getStoryAeneidDeliveryDefaults()
  const tokenGateCondition = maybe(input.env.STORY_TOKEN_GATE_CONDITION_ADDRESS) || defaults.tokenGateCondition
  if (tokenGateCondition && input.storyReadCondition.toLowerCase() === tokenGateCondition.toLowerCase()) {
    const entitlementTokenAddress = requireAddress(
      maybe(input.env.STORY_ENTITLEMENT_TOKEN_ADDRESS) || defaults.purchaseEntitlementToken,
      "story_entitlement_token_address",
    )
    const tokenId = BigInt(requireNonEmptyString(input.storyEntitlementTokenId, "story_entitlement_token_id"))
    return encodeAbiParameters(
      [
        { name: "entitlementToken", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "minBalance", type: "uint256" },
      ],
      [entitlementTokenAddress, tokenId, 1n],
    )
  }
  return requireBytes32(input.asset.story_namespace, "story_namespace")
}

function buildWriteConditionData(env: Env, ownerAddress: `0x${string}`): `0x${string}` {
  const configured = maybe(env.STORY_CDR_WRITE_CONDITION_DATA)
  if (!configured) {
    return encodeAbiParameters(
      [{ name: "owner", type: "address" }],
      [ownerAddress],
    )
  }
  if (!/^0x[a-fA-F0-9]*$/.test(configured) || configured.length % 2 !== 0) {
    throw new Error("story_cdr_write_condition_data_invalid")
  }
  return configured as `0x${string}`
}

function normalizeCidLike(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith("ipfs://") ? trimmed.slice("ipfs://".length) : trimmed
}

function uuidToLabel(uuid: number): Uint8Array {
  const label = new Uint8Array(32)
  const view = new DataView(label.buffer)
  view.setUint32(28, uuid, false)
  return label
}

function assertSuccessfulReceipt(input: {
  status: string
  label: string
}): void {
  if (input.status !== "success") {
    throw new Error(`${input.label}_tx_reverted`)
  }
}

class PirateSongArtifactStorageProvider implements StorageProvider {
  constructor(
    private readonly env: Env,
    private readonly assetId: string,
  ) {}

  async upload(data: Uint8Array): Promise<string> {
    const persisted = await persistSongArtifactUpload({
      env: this.env,
      uploadId: `cdr_${this.assetId}`,
      bytes: data,
      artifactKind: "locked_payload",
      mimeType: "application/octet-stream",
    })
    return normalizeCidLike(persisted.storageRef)
  }

  async download(cid: string): Promise<Uint8Array> {
    return await readStoredSongArtifactBytes(this.env, cid.startsWith("ipfs://") ? cid : `ipfs://${cid}`)
  }
}

async function ensureCdrWasm(): Promise<void> {
  if (!wasmInitPromise) {
    wasmInitPromise = initWasm()
  }
  await wasmInitPromise
}

export function hasStoryCdrSdkWriterConfigured(env: Env): boolean {
  return Boolean(maybe(env.STORY_CDR_WRITER_PRIVATE_KEY))
}

export function getDefaultGatewayBaseUrl(env: Env): string {
  return String(env.IPFS_GATEWAY_URL || DEFAULT_IPFS_GATEWAY_URL).trim().replace(/\/+$/, "")
}

export async function uploadSongAssetToCdrViaSdk(input: {
  env: Env
  asset: Asset
  storyEntitlementTokenId: string
}): Promise<{
  lockedDeliveryRef: string
  lockedDeliveryPayload: null
  storyCdrVaultUuid: number
  storyCdrEncryptedCid: string
  storyCdrAllocateTxRef: string
  storyCdrWriteTxRef: string
  storyEntitlementTokenId: string
  storyReadCondition: string
  storyWriteCondition: string
}> {
  const privateKey = requirePrivateKey(input.env.STORY_CDR_WRITER_PRIVATE_KEY, "story_cdr_writer_private_key")
  const defaults = getStoryAeneidDeliveryDefaults()
  const rpcUrl = String(input.env.STORY_AENEID_RPC_URL || defaults.rpcUrl || DEFAULT_STORY_AENEID_RPC_URL).trim()
  const sourceStorageRef = requireNonEmptyString(input.asset.primary_content_ref, "primary_content_ref")
  const sourceBytes = await readStoredSongArtifactBytes(input.env, sourceStorageRef)
  if (sourceBytes.byteLength === 0) {
    throw new Error("locked_delivery_source_empty")
  }

  const storyReadCondition = requireAddress(
    input.env.STORY_CDR_READ_CONDITION_ADDRESS
      || input.env.STORY_TOKEN_GATE_CONDITION_ADDRESS
      || defaults.tokenGateCondition
      || input.env.STORY_SIGNED_ACCESS_CONDITION_ADDRESS
      || defaults.signedAccessConditionV1,
    "story_cdr_read_condition_address",
  )
  const storyWriteCondition = requireAddress(
    input.env.STORY_CDR_WRITE_CONDITION_ADDRESS
      || input.env.STORY_SIGNED_ACCESS_CONDITION_ADDRESS
      || defaults.signedAccessConditionV1,
    "story_cdr_write_condition_address",
  )

  const account = privateKeyToAccount(privateKey)
  const publicClient = createPublicClient({
    transport: http(rpcUrl),
  })
  const walletClient = createWalletClient({
    account,
    transport: http(rpcUrl),
  })
  const dkg = resolveCdrDkgConfig(input.env)

  await ensureCdrWasm()
  const client = new CDRClient({
    network: "testnet",
    publicClient,
    walletClient,
    dkgSource: dkg.dkgSource,
    cometRpcUrl: dkg.cometRpcUrl,
  })
  const globalPubKey = await client.observer.getGlobalPubKey()
  const storageProvider = new PirateSongArtifactStorageProvider(input.env, input.asset.asset_id)
  const { ciphertext: encryptedFile, key } = encryptFile(sourceBytes)
  const cid = await storageProvider.upload(encryptedFile)
  const payloadBytes = new TextEncoder().encode(JSON.stringify({
    cid,
    key: toHex(key),
  }))
  const readConditionData = buildReadConditionData({
    asset: input.asset,
    env: input.env,
    storyEntitlementTokenId: input.storyEntitlementTokenId,
    storyReadCondition,
  })
  const writeConditionData = buildWriteConditionData(input.env, account.address)
  const cdrAddress = contractAddresses.testnet.cdr
  const allocateFee = await publicClient.readContract({
    address: cdrAddress,
    abi: cdrAbi,
    functionName: "allocateFee",
  })
  const allocateTx = await walletClient.writeContract({
    chain: walletClient.chain ?? null,
    account: walletClient.account ?? null,
    address: cdrAddress,
    abi: cdrAbi,
    functionName: "allocate",
    args: [
      false,
      storyWriteCondition,
      storyReadCondition,
      writeConditionData,
      readConditionData,
    ],
    value: allocateFee,
    gas: DEFAULT_CDR_ALLOCATE_GAS,
    gasPrice: DEFAULT_CDR_TX_GAS_PRICE,
  })
  const allocateReceipt = await publicClient.waitForTransactionReceipt({ hash: allocateTx })
  assertSuccessfulReceipt({
    status: allocateReceipt.status,
    label: "story_cdr_allocate",
  })
  const allocateLogs = parseEventLogs({
    abi: cdrAbi,
    logs: allocateReceipt.logs,
    eventName: "VaultAllocated",
  })
  if (allocateLogs.length === 0) {
    throw new Error("story_cdr_vault_allocate_missing")
  }
  const uuid = Number(allocateLogs[0].args.uuid)
  const label = uuidToLabel(uuid)
  const ciphertext = await client.uploader.encryptDataKey({
    dataKey: payloadBytes,
    globalPubKey,
    label,
  })
  const writeFee = await publicClient.readContract({
    address: cdrAddress,
    abi: cdrAbi,
    functionName: "writeFee",
  })
  const writeTx = await walletClient.writeContract({
    chain: walletClient.chain ?? null,
    account: walletClient.account ?? null,
    address: cdrAddress,
    abi: cdrAbi,
    functionName: "write",
    args: [uuid, "0x", toHex(ciphertext.raw)],
    value: writeFee,
    gas: DEFAULT_CDR_WRITE_GAS,
    gasPrice: DEFAULT_CDR_TX_GAS_PRICE,
  })
  const writeReceipt = await publicClient.waitForTransactionReceipt({ hash: writeTx })
  assertSuccessfulReceipt({
    status: writeReceipt.status,
    label: "story_cdr_write",
  })

  return {
    lockedDeliveryRef: `cdr://vault/${uuid}`,
    lockedDeliveryPayload: null,
    storyCdrVaultUuid: uuid,
    storyCdrEncryptedCid: cid,
    storyCdrAllocateTxRef: allocateTx,
    storyCdrWriteTxRef: writeTx,
    storyEntitlementTokenId: input.storyEntitlementTokenId,
    storyReadCondition,
    storyWriteCondition,
  }
}
