import {
  createPublicClient,
  decodeEventLog,
  fallback,
  getAddress,
  http,
  parseAbi,
  type Address,
  type Hash,
  type Hex,
} from "viem"
import { WIP_TOKEN_ADDRESS } from "@story-protocol/core-sdk"
import type { Env } from "../../env"
import { sha256Hex } from "../crypto"
import {
  resolveStoryRoyaltyPolicyAddress,
  type StoryRoyaltyRegistrationResult,
} from "./story-royalty-registration-service"
import type { StoryRegistrationEffect } from "./story-registration-effect-store"
import { resolveStoryRpcUrls } from "./story-runtime-config"

const STORY_IP_ASSET_REGISTRY_BY_CHAIN: Readonly<Record<number, Address>> = {
  1315: "0x77319B4031e6eF1250907aa00018B8B1c67a244b",
  1514: "0x77319B4031e6eF1250907aa00018B8B1c67a244b",
}

const STORY_CORE_METADATA_MODULE_BY_CHAIN: Readonly<Record<number, Address>> = {
  1315: "0x6E81a25C99C6e8430aeC7353325EB138aFE5DC16",
  1514: "0x6E81a25C99C6e8430aeC7353325EB138aFE5DC16",
}

const STORY_LICENSING_MODULE_BY_CHAIN: Readonly<Record<number, Address>> = {
  1315: "0x04fbd8a2e56dd85CFD5500A4A4DfA955B9f1dE6f",
  1514: "0x04fbd8a2e56dd85CFD5500A4A4DfA955B9f1dE6f",
}

const STORY_ROYALTY_MODULE_BY_CHAIN: Readonly<Record<number, Address>> = {
  1315: "0xD2f60c40fEbccf6311f8B47c4f2Ec6b040400086",
  1514: "0xD2f60c40fEbccf6311f8B47c4f2Ec6b040400086",
}

const IP_REGISTERED_ABI = parseAbi([
  "event IPRegistered(address ipId, uint256 indexed chainId, address indexed tokenContract, uint256 indexed tokenId, string name, string uri, uint256 registrationDate)",
])

const STORY_RECOVERY_ABI = parseAbi([
  "event MetadataURISet(address indexed ipId, string metadataURI, bytes32 metadataHash)",
  "event NFTTokenURISet(address indexed ipId, string nftTokenURI, bytes32 nftMetadataHash)",
  "event LicenseTermsAttached(address indexed caller, address indexed ipId, address licenseTemplate, uint256 licenseTermsId)",
  "event DerivativeRegistered(address indexed caller, address indexed childIpId, uint256[] licenseTokenIds, address[] parentIpIds, uint256[] licenseTermsIds, address licenseTemplate)",
  "event IpRoyaltyVaultDeployed(address ipId, address ipRoyaltyVault)",
])

const STORY_REGISTRATION_RESOLUTION_MIN_CONFIRMATIONS = 5n

type ReceiptLog = {
  address: Address
  data: Hex
  topics: readonly Hex[]
}

export type StoryRegistrationReceiptClient = {
  getChainId(): Promise<number>
  getBlockNumber(): Promise<bigint>
  getBlock(input: { blockNumber: bigint }): Promise<{ hash: Hash }>
  getTransaction(input: { hash: Hash }): Promise<{ from: Address }>
  getTransactionReceipt(input: { hash: Hash }): Promise<{
    blockHash: Hash
    blockNumber: bigint
    logs: ReceiptLog[]
    status: "success" | "reverted"
    transactionHash: Hash
  }>
}

export type StoryRegistrationReceiptEvidence = {
  blockHash: Hash
  blockNumber: string
  providerTxRef: Hash
  storyIpId: Address
  storyIpNftContract: Address
  storyIpNftTokenId: string
}

export type StoryRegistrationRevertedReceiptEvidence = {
  blockHash: Hash
  blockNumber: string
  providerTxRef: Hash
  outcome: "reverted"
}

export class StoryRegistrationResolutionError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: 400 | 409 | 503,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "StoryRegistrationResolutionError"
  }
}

function requiredString(record: Record<string, unknown>, key: string, maxLength = 2_048): string {
  const value = typeof record[key] === "string" ? record[key].trim() : ""
  if (!value || value.length > maxLength) {
    throw new StoryRegistrationResolutionError("invalid_story_registration_result", 400, `${key} is required`)
  }
  return value
}

function nullableString(record: Record<string, unknown>, key: string, maxLength = 2_048): string | null {
  if (record[key] == null) return null
  const value = typeof record[key] === "string" ? record[key].trim() : ""
  if (!value || value.length > maxLength) {
    throw new StoryRegistrationResolutionError("invalid_story_registration_result", 400, `${key} is invalid`)
  }
  return value
}

function address(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key, 42)
  try {
    return getAddress(value)
  } catch (cause) {
    throw new StoryRegistrationResolutionError("invalid_story_registration_result", 400, `${key} is invalid`, { cause })
  }
}

function nullableAddress(record: Record<string, unknown>, key: string): string | null {
  const value = nullableString(record, key, 42)
  if (!value) return null
  try {
    return getAddress(value)
  } catch (cause) {
    throw new StoryRegistrationResolutionError("invalid_story_registration_result", 400, `${key} is invalid`, { cause })
  }
}

function bytes32(record: Record<string, unknown>, key: string): string {
  const value = requiredString(record, key, 66)
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new StoryRegistrationResolutionError("invalid_story_registration_result", 400, `${key} is invalid`)
  }
  return value.toLowerCase()
}

function nullableTxHash(record: Record<string, unknown>, key: string): string | null {
  const value = nullableString(record, key, 66)
  if (value && !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new StoryRegistrationResolutionError("invalid_story_registration_result", 400, `${key} is invalid`)
  }
  return value?.toLowerCase() ?? null
}

function nullableAddressArray(record: Record<string, unknown>, key: string): string[] | null {
  if (record[key] == null) return null
  if (!Array.isArray(record[key]) || record[key].length === 0 || record[key].length > 32) {
    throw new StoryRegistrationResolutionError("invalid_story_registration_result", 400, `${key} is invalid`)
  }
  return record[key].map((value) => {
    try {
      return getAddress(requiredString({ value }, "value", 42))
    } catch (cause) {
      if (cause instanceof StoryRegistrationResolutionError) throw cause
      throw new StoryRegistrationResolutionError("invalid_story_registration_result", 400, `${key} is invalid`, { cause })
    }
  })
}

export function parseStoryRegistrationResolutionResult(
  value: unknown,
  registrationKind: StoryRegistrationEffect["registrationKind"],
): StoryRoyaltyRegistrationResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StoryRegistrationResolutionError("invalid_story_registration_result", 400, "result is required")
  }
  const record = value as Record<string, unknown>
  const tokenId = requiredString(record, "storyIpNftTokenId", 78)
  if (!/^\d+$/.test(tokenId)) {
    throw new StoryRegistrationResolutionError("invalid_story_registration_result", 400, "storyIpNftTokenId is invalid")
  }
  const licenseTermsId = nullableString(record, "storyLicenseTermsId", 78)
  if (licenseTermsId && !/^\d+$/.test(licenseTermsId)) {
    throw new StoryRegistrationResolutionError("invalid_story_registration_result", 400, "storyLicenseTermsId is invalid")
  }
  const parentIpIds = nullableAddressArray(record, "storyDerivativeParentIpIds")
  const derivativeRegisteredAt = nullableString(record, "storyDerivativeRegisteredAt", 40)
  if (registrationKind === "derivative" && (!parentIpIds || !derivativeRegisteredAt)) {
    throw new StoryRegistrationResolutionError("invalid_story_registration_result", 400, "derivative recovery requires parents and registration time")
  }
  if (registrationKind === "original" && (parentIpIds || derivativeRegisteredAt)) {
    throw new StoryRegistrationResolutionError("invalid_story_registration_result", 400, "original recovery cannot contain derivative fields")
  }
  if (derivativeRegisteredAt && Number.isNaN(Date.parse(derivativeRegisteredAt))) {
    throw new StoryRegistrationResolutionError("invalid_story_registration_result", 400, "storyDerivativeRegisteredAt is invalid")
  }
  if (record.storyRoyaltyRegistrationStatus !== "registered") {
    throw new StoryRegistrationResolutionError("invalid_story_registration_result", 400, "storyRoyaltyRegistrationStatus must be registered")
  }

  return {
    storyIpId: address(record, "storyIpId"),
    storyIpNftContract: address(record, "storyIpNftContract"),
    storyIpNftTokenId: tokenId,
    storyIpMetadataUri: requiredString(record, "storyIpMetadataUri"),
    storyIpMetadataHash: bytes32(record, "storyIpMetadataHash"),
    storyNftMetadataUri: requiredString(record, "storyNftMetadataUri"),
    storyNftMetadataHash: bytes32(record, "storyNftMetadataHash"),
    ipRoyaltyVault: nullableAddress(record, "ipRoyaltyVault"),
    storyLicenseTermsId: licenseTermsId,
    storyLicenseTemplate: nullableAddress(record, "storyLicenseTemplate"),
    storyRoyaltyPolicy: address(record, "storyRoyaltyPolicy"),
    storyDerivativeParentIpIds: parentIpIds,
    storyRevenueToken: address(record, "storyRevenueToken"),
    storyRoyaltyRegistrationStatus: "registered",
    storyDerivativeRegisteredAt: derivativeRegisteredAt,
    royaltyDistributionTxHash: nullableTxHash(record, "royaltyDistributionTxHash"),
  }
}

function receiptClientForEnv(env: Env): StoryRegistrationReceiptClient {
  const client = createPublicClient({
    transport: fallback(resolveStoryRpcUrls(env).map((url) => http(url))),
  })
  return client as unknown as StoryRegistrationReceiptClient
}

function storyMetadataReadUrl(env: Env, uri: string): string {
  if (uri.startsWith("ipfs://")) {
    const reference = uri.slice("ipfs://".length).replace(/^\/+/, "")
    const gateway = String(env.IPFS_GATEWAY_URL || "https://psc.myfilebase.com/ipfs").trim().replace(/\/+$/, "")
    if (/^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/.test(reference)) return `${gateway}/${reference}`
  }
  if (uri.startsWith("bzz://")) {
    const reference = uri.slice("bzz://".length).replace(/^\/+/, "")
    const gateway = String(env.SWARM_BEE_API_URL || "").trim().replace(/\/+$/, "")
    if (gateway && /^[0-9a-fA-F]{64}$/.test(reference)) return `${gateway}/bzz/${reference}`
  }
  throw new StoryRegistrationResolutionError("story_metadata_uri_unreadable", 409, "Story metadata URI cannot be verified")
}

async function verifyStoryMetadataIdentity(input: {
  env: Env
  effect: StoryRegistrationEffect
  communityId: string
  assetId: string
  result: StoryRoyaltyRegistrationResult
  fetchImpl?: typeof fetch
}): Promise<void> {
  const fetchImpl = input.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(storyMetadataReadUrl(input.env, input.result.storyIpMetadataUri), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    })
  } catch (cause) {
    if (cause instanceof StoryRegistrationResolutionError) throw cause
    throw new StoryRegistrationResolutionError(
      "story_metadata_unavailable",
      503,
      "Story metadata could not be read; no journal state changed",
      { cause },
    )
  }
  if (!response.ok) {
    throw new StoryRegistrationResolutionError("story_metadata_unavailable", 503, "Story metadata could not be read; no journal state changed")
  }
  const declaredLength = Number(response.headers.get("content-length") || 0)
  if (declaredLength > 1_000_000) {
    throw new StoryRegistrationResolutionError("story_metadata_too_large", 409, "Story metadata exceeds the recovery limit")
  }
  let body: string
  try {
    body = await response.text()
  } catch (cause) {
    throw new StoryRegistrationResolutionError(
      "story_metadata_unavailable",
      503,
      "Story metadata could not be read; no journal state changed",
      { cause },
    )
  }
  if (body.length > 1_000_000 || `0x${await sha256Hex(body)}`.toLowerCase() !== input.result.storyIpMetadataHash.toLowerCase()) {
    throw new StoryRegistrationResolutionError("story_metadata_hash_mismatch", 409, "Story metadata does not match its canonical hash")
  }
  let metadata: Record<string, unknown>
  try {
    const parsed = JSON.parse(body) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid metadata")
    metadata = parsed as Record<string, unknown>
  } catch (cause) {
    throw new StoryRegistrationResolutionError("story_metadata_invalid", 409, "Story metadata is not valid JSON", { cause })
  }
  if (
    metadata.community_id !== input.communityId
    || metadata.asset_id !== input.assetId
    || String(metadata.primary_content_hash || "").toLowerCase() !== input.effect.primaryContentHash.toLowerCase()
    || metadata.rights_basis !== input.effect.registrationKind
    || String(metadata.creator_wallet_address || "").toLowerCase() !== input.effect.creatorWalletAddress.toLowerCase()
  ) {
    throw new StoryRegistrationResolutionError("story_metadata_identity_mismatch", 409, "Story metadata belongs to a different journal request")
  }
}

async function readStoryRegistrationReceipt(input: {
  env: Env
  effect: StoryRegistrationEffect
  providerTxRef: string
  client?: StoryRegistrationReceiptClient
}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.providerTxRef)) {
    throw new StoryRegistrationResolutionError("invalid_provider_tx_ref", 400, "provider_tx_ref must be a transaction hash")
  }
  if (input.effect.providerTxRef && input.effect.providerTxRef.toLowerCase() !== input.providerTxRef.toLowerCase()) {
    throw new StoryRegistrationResolutionError("provider_tx_ref_conflict", 409, "transaction hash differs from the journal")
  }
  const expectedRegistry = STORY_IP_ASSET_REGISTRY_BY_CHAIN[input.effect.chainId]
  if (!expectedRegistry) {
    throw new StoryRegistrationResolutionError("unsupported_story_chain", 409, "Story registry is not configured for this chain")
  }
  const client = input.client ?? receiptClientForEnv(input.env)
  const hash = input.providerTxRef as Hash
  let chainId: number
  let transaction: Awaited<ReturnType<StoryRegistrationReceiptClient["getTransaction"]>>
  let receipt: Awaited<ReturnType<StoryRegistrationReceiptClient["getTransactionReceipt"]>>
  try {
    ;[chainId, transaction, receipt] = await Promise.all([
      client.getChainId(),
      client.getTransaction({ hash }),
      client.getTransactionReceipt({ hash }),
    ])
  } catch (cause) {
    throw new StoryRegistrationResolutionError(
      "story_registration_receipt_unavailable",
      503,
      "Story transaction or receipt could not be read; no journal state changed",
      { cause },
    )
  }
  if (chainId !== input.effect.chainId) {
    throw new StoryRegistrationResolutionError("story_chain_mismatch", 409, "RPC chain does not match the journal")
  }
  if (transaction.from.toLowerCase() !== input.effect.signerAddress.toLowerCase()) {
    throw new StoryRegistrationResolutionError("story_signer_mismatch", 409, "transaction signer does not match the journal")
  }
  if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) {
    throw new StoryRegistrationResolutionError("story_receipt_hash_mismatch", 409, "receipt hash does not match the requested transaction")
  }
  let latestBlockNumber: bigint
  let canonicalBlock: { hash: Hash }
  try {
    ;[latestBlockNumber, canonicalBlock] = await Promise.all([
      client.getBlockNumber(),
      client.getBlock({ blockNumber: receipt.blockNumber }),
    ])
  } catch (cause) {
    throw new StoryRegistrationResolutionError(
      "story_receipt_finality_unavailable",
      503,
      "Story receipt finality could not be verified; no journal state changed",
      { cause },
    )
  }
  if (canonicalBlock.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    throw new StoryRegistrationResolutionError("story_receipt_reorged", 409, "receipt block is no longer canonical")
  }
  const confirmations = latestBlockNumber >= receipt.blockNumber
    ? latestBlockNumber - receipt.blockNumber + 1n
    : 0n
  if (confirmations < STORY_REGISTRATION_RESOLUTION_MIN_CONFIRMATIONS) {
    throw new StoryRegistrationResolutionError("story_receipt_not_final", 409, "receipt does not yet have enough confirmations")
  }
  return { expectedRegistry, hash, receipt }
}

export async function verifyStoryRegistrationRevertedReceipt(input: {
  env: Env
  effect: StoryRegistrationEffect
  providerTxRef: string
  client?: StoryRegistrationReceiptClient
}): Promise<StoryRegistrationRevertedReceiptEvidence> {
  const { hash, receipt } = await readStoryRegistrationReceipt(input)
  if (receipt.status !== "reverted") {
    throw new StoryRegistrationResolutionError("story_receipt_not_reverted", 409, "transaction receipt is not reverted")
  }
  return {
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber.toString(),
    providerTxRef: hash,
    outcome: "reverted",
  }
}

export async function verifyStoryRegistrationReceipt(input: {
  env: Env
  effect: StoryRegistrationEffect
  communityId: string
  assetId: string
  providerTxRef: string
  result: StoryRoyaltyRegistrationResult
  client?: StoryRegistrationReceiptClient
  fetchImpl?: typeof fetch
}): Promise<StoryRegistrationReceiptEvidence> {
  const { expectedRegistry, hash, receipt } = await readStoryRegistrationReceipt(input)
  if (receipt.status !== "success") {
    throw new StoryRegistrationResolutionError("story_receipt_not_successful", 409, "transaction receipt is not successful")
  }

  const registrations = receipt.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== expectedRegistry.toLowerCase()) return []
    try {
      const decoded = decodeEventLog({
        abi: IP_REGISTERED_ABI,
        eventName: "IPRegistered",
        data: log.data,
        topics: log.topics as [signature: Hex, ...args: Hex[]],
        strict: true,
      })
      return [decoded.args]
    } catch {
      return []
    }
  })
  if (registrations.length !== 1) {
    throw new StoryRegistrationResolutionError("story_ip_registration_event_mismatch", 409, "receipt must contain exactly one canonical IP registration")
  }
  const registration = registrations[0]
  if (
    Number(registration.chainId) !== input.effect.chainId
    || registration.ipId.toLowerCase() !== input.result.storyIpId.toLowerCase()
    || registration.tokenContract.toLowerCase() !== input.result.storyIpNftContract.toLowerCase()
    || registration.tokenId.toString() !== input.result.storyIpNftTokenId
  ) {
    throw new StoryRegistrationResolutionError("story_ip_registration_result_mismatch", 409, "recovery result does not match the receipt")
  }
  const configuredSpg = String(input.env.STORY_ROYALTY_SPG_NFT_CONTRACT || "").trim()
  if (configuredSpg && registration.tokenContract.toLowerCase() !== configuredSpg.toLowerCase()) {
    throw new StoryRegistrationResolutionError("story_spg_contract_mismatch", 409, "registered NFT is not from the configured SPG collection")
  }

  const metadataModule = STORY_CORE_METADATA_MODULE_BY_CHAIN[input.effect.chainId]
  const licensingModule = STORY_LICENSING_MODULE_BY_CHAIN[input.effect.chainId]
  const royaltyModule = STORY_ROYALTY_MODULE_BY_CHAIN[input.effect.chainId]
  const recoveryEvents = receipt.logs.flatMap((log) => {
    try {
      const decoded = decodeEventLog({
        abi: STORY_RECOVERY_ABI,
        data: log.data,
        topics: log.topics as [signature: Hex, ...args: Hex[]],
        strict: true,
      })
      const expectedEmitter = decoded.eventName === "MetadataURISet" || decoded.eventName === "NFTTokenURISet"
        ? metadataModule
        : decoded.eventName === "IpRoyaltyVaultDeployed"
        ? royaltyModule
        : licensingModule
      return expectedEmitter && log.address.toLowerCase() === expectedEmitter.toLowerCase() ? [decoded] : []
    } catch {
      return []
    }
  })
  const metadataEvent = recoveryEvents.find((event) => event.eventName === "MetadataURISet")
  const nftMetadataEvent = recoveryEvents.find((event) => event.eventName === "NFTTokenURISet")
  if (
    !metadataEvent
    || metadataEvent.args.ipId.toLowerCase() !== input.result.storyIpId.toLowerCase()
    || metadataEvent.args.metadataURI !== input.result.storyIpMetadataUri
    || metadataEvent.args.metadataHash.toLowerCase() !== input.result.storyIpMetadataHash.toLowerCase()
    || !nftMetadataEvent
    || nftMetadataEvent.args.ipId.toLowerCase() !== input.result.storyIpId.toLowerCase()
    || nftMetadataEvent.args.nftTokenURI !== input.result.storyNftMetadataUri
    || nftMetadataEvent.args.nftMetadataHash.toLowerCase() !== input.result.storyNftMetadataHash.toLowerCase()
  ) {
    throw new StoryRegistrationResolutionError("story_metadata_result_mismatch", 409, "recovery metadata does not match canonical Story events")
  }

  if (input.effect.registrationKind === "original") {
    const licenseEvent = recoveryEvents.find((event) => (
      event.eventName === "LicenseTermsAttached"
      && event.args.ipId.toLowerCase() === input.result.storyIpId.toLowerCase()
    )) as Extract<(typeof recoveryEvents)[number], { eventName: "LicenseTermsAttached" }> | undefined
    if (!licenseEvent || licenseEvent.args.licenseTermsId.toString() !== input.result.storyLicenseTermsId) {
      throw new StoryRegistrationResolutionError("story_license_result_mismatch", 409, "recovery license terms do not match the receipt")
    }
  } else {
    const derivativeEvent = recoveryEvents.find((event) => (
      event.eventName === "DerivativeRegistered"
      && event.args.childIpId.toLowerCase() === input.result.storyIpId.toLowerCase()
    )) as Extract<(typeof recoveryEvents)[number], { eventName: "DerivativeRegistered" }> | undefined
    const expectedParents = input.result.storyDerivativeParentIpIds?.map((parent) => parent.toLowerCase()) ?? []
    const actualParents = derivativeEvent?.args.parentIpIds.map((parent) => parent.toLowerCase()) ?? []
    if (!derivativeEvent || JSON.stringify(actualParents) !== JSON.stringify(expectedParents)) {
      throw new StoryRegistrationResolutionError("story_derivative_result_mismatch", 409, "recovery parents do not match the receipt")
    }
  }

  if (input.result.ipRoyaltyVault) {
    const vaultEvent = recoveryEvents.find((event) => (
      event.eventName === "IpRoyaltyVaultDeployed"
      && event.args.ipId.toLowerCase() === input.result.storyIpId.toLowerCase()
    )) as Extract<(typeof recoveryEvents)[number], { eventName: "IpRoyaltyVaultDeployed" }> | undefined
    if (!vaultEvent || vaultEvent.args.ipRoyaltyVault.toLowerCase() !== input.result.ipRoyaltyVault.toLowerCase()) {
      throw new StoryRegistrationResolutionError("story_royalty_vault_result_mismatch", 409, "recovery royalty vault does not match the receipt")
    }
  }
  if (
    input.result.storyRoyaltyPolicy.toLowerCase() !== resolveStoryRoyaltyPolicyAddress(input.env).toLowerCase()
    || input.result.storyRevenueToken.toLowerCase() !== WIP_TOKEN_ADDRESS.toLowerCase()
    || (
      input.result.royaltyDistributionTxHash
      && input.result.royaltyDistributionTxHash.toLowerCase() !== hash.toLowerCase()
    )
  ) {
    throw new StoryRegistrationResolutionError("story_royalty_result_mismatch", 409, "recovery royalty configuration does not match runtime or receipt")
  }
  await verifyStoryMetadataIdentity(input)

  return {
    blockHash: receipt.blockHash,
    blockNumber: receipt.blockNumber.toString(),
    providerTxRef: hash,
    storyIpId: getAddress(registration.ipId),
    storyIpNftContract: getAddress(registration.tokenContract),
    storyIpNftTokenId: registration.tokenId.toString(),
  }
}
