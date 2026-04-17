import type { Client } from "@libsql/client"
import { AbiCoder } from "ethers"
import { executeFirst } from "../db-helpers"
import { badRequestError, eligibilityFailed, notFoundError, verificationRequired } from "../errors"
import { makeId, nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { getCommunityMembershipState } from "./community-membership-store"
import { openCommunityDb } from "./community-db-factory"
import type { CommunityRepository } from "./control-plane-community-repository"
import { getPostById } from "../posts/community-post-store"
import {
  fetchSongArtifactBytes,
  sha256Hex,
  uploadFilebaseObject,
} from "../song-artifacts/song-artifact-storage"
import { findUploadedSongArtifactByStorageRef } from "../song-artifacts/song-artifact-repository"
import type { UserRepository } from "../auth/repositories"
import { getPrimaryWalletSnapshot } from "./community-serialization"
import {
  generateStorySignedAccessProof,
  type StoryAccessScope,
} from "../story/story-access-proof-service"
import {
  deriveEntitlementTokenId,
  deriveStorageRefHash,
  deriveStoryAssetVersionId,
  deriveStoryNamespace,
  hashBytes32FromParts,
  encodeSignedAccessNamespace,
  encodeWriteConditionOperatorData,
} from "../story/story-identifiers"
import {
  resolveStoryCdrContracts,
  uploadCdrEncryptedDataKey,
} from "../story/story-cdr"
import { resolveStoryCdrWriterPkpExecutionConfig } from "../story/cdr-writer-pkp"
import {
  publishLockedAssetVersionToStory,
} from "../story/story-publish-service"
import {
  resolveStoryChainId,
  resolveStoryRpcUrl,
  STORY_DELIVERY_CONTRACTS,
} from "../story/story-runtime-config"
import type {
  Asset,
  AssetAccessResponse,
  CommunityListing,
  CommunityListingListResponse,
  CommunityMoneyPolicy,
  CommunityPurchase,
  CommunityPurchaseListResponse,
  CommunityPurchaseQuote,
  CommunityPurchaseQuotePreflight,
  CommunityPurchaseQuotePreflightRequest,
  CommunityPurchaseQuoteRequest,
  CommunityPurchaseSettlement,
  CommunityPurchaseSettlementFailure,
  CommunityPurchaseSettlementFailureRequest,
  CommunityPurchaseSettlementRequest,
  CommunityPricingPolicy,
  CreateCommunityListingRequest,
  Env,
  Post,
  SongArtifactBundle,
  UpdateCommunityListingRequest,
  UpdateCommunityMoneyPolicyRequest,
  UpdateCommunityPricingPolicyRequest,
} from "../../types"

type AssetRow = {
  asset_id: string
  community_id: string
  source_post_id: string
  song_artifact_bundle_id: string | null
  creator_user_id: string
  asset_kind: Asset["asset_kind"]
  rights_basis: Asset["rights_basis"]
  access_mode: Asset["access_mode"]
  primary_content_ref: string
  primary_content_hash: string | null
  publication_status: Asset["publication_status"]
  story_status: Asset["story_status"]
  story_error: string | null
  story_ip_id: string | null
  story_publish_tx_ref: string | null
  story_asset_version_id: string | null
  story_cdr_vault_uuid: number | null
  story_namespace: string | null
  story_entitlement_token_id: string | null
  story_read_condition: string | null
  story_write_condition: string | null
  locked_delivery_status: Asset["locked_delivery_status"]
  locked_delivery_ref: string | null
  locked_delivery_error: string | null
  locked_delivery_storage_ref: string | null
  locked_delivery_secret_json: string | null
  created_at: string
  updated_at: string
}

type ListingRow = {
  listing_id: string
  community_id: string
  asset_id: string | null
  live_room_id: string | null
  listing_mode: CommunityListing["listing_mode"]
  status: CommunityListing["status"]
  price_usd: number
  regional_pricing_policy_json: string | null
  created_by_user_id: string
  created_at: string
  updated_at: string
}

type PurchaseQuoteRow = {
  quote_id: string
  community_id: string
  listing_id: string
  buyer_user_id: string
  asset_id: string | null
  live_room_id: string | null
  base_price_usd: number
  pricing_tier: string | null
  final_price_usd: number
  funding_mode: "direct" | "routed"
  funding_asset_json: string | null
  source_chain_json: string | null
  route_provider: string | null
  route_policy_compliant: boolean
  route_live_available: boolean | null
  policy_origin: CommunityMoneyPolicy["policy_origin"]
  destination_settlement_chain_json: string
  destination_settlement_token: string
  treasury_denomination: string | null
  quote_ttl_seconds: number
  route_required: boolean
  route_status_policy: CommunityMoneyPolicy["route_status_policy"]
  route_hop_tolerance: number
  verification_snapshot_ref: string | null
  pricing_policy_version: string | null
  status: "active" | "expired" | "consumed" | "failed"
  quoted_at: string
  expires_at: string
  consumed_at: string | null
  failed_at: string | null
  created_at: string
  updated_at: string
}

type PurchaseRow = {
  purchase_id: string
  community_id: string
  listing_id: string
  asset_id: string | null
  live_room_id: string | null
  buyer_user_id: string
  settlement_wallet_attachment_id: string
  purchase_price_usd: number
  pricing_tier: string | null
  settlement_chain: string
  settlement_token: string
  settlement_tx_ref: string
  created_at: string
}

type PurchaseEntitlementRow = {
  purchase_entitlement_id: string
  purchase_id: string
  community_id: string
  buyer_user_id: string
  entitlement_kind: CommunityPurchase["entitlement_kind"]
  target_ref: string
  status: "active" | "revoked" | "expired"
  granted_at: string
  revoked_at: string | null
  created_at: string
  updated_at: string
}

type LockedDeliverySecret = {
  algorithm: "AES-GCM"
  iv_b64: string
  mime_type: string
}

const abiCoder = AbiCoder.defaultAbiCoder()

function parseJsonValue<T>(value: string | null, fallback: T): T {
  if (!value?.trim()) {
    return fallback
  }
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function toChainRefString(chain: CommunityMoneyPolicy["destination_settlement_chain"]): string {
  return chain.chain_id != null ? `${chain.chain_namespace}:${chain.chain_id}` : chain.chain_namespace
}

function boolToSqlite(value: boolean): 0 | 1 {
  return value ? 1 : 0
}

function sqliteToBool(value: unknown): boolean {
  return Number(value ?? 0) === 1
}

function requiredString(row: unknown, key: string): string {
  if (!row || typeof row !== "object" || !(key in row)) {
    throw notFoundError(`Missing ${key}`)
  }
  const value = (row as Record<string, unknown>)[key]
  if (typeof value !== "string") {
    throw notFoundError(`Missing ${key}`)
  }
  return value
}

function stringOrNull(row: unknown, key: string): string | null {
  if (!row || typeof row !== "object" || !(key in row)) {
    return null
  }
  const value = (row as Record<string, unknown>)[key]
  return typeof value === "string" ? value : null
}

function numberOrNull(row: unknown, key: string): number | null {
  if (!row || typeof row !== "object" || !(key in row)) {
    return null
  }
  const value = (row as Record<string, unknown>)[key]
  if (typeof value === "number") {
    return value
  }
  if (typeof value === "bigint") {
    return Number(value)
  }
  return null
}

function serializeAsset(row: AssetRow, input?: { redactPrimaryForLocked?: boolean }): Asset {
  const primaryContentRef = input?.redactPrimaryForLocked && row.access_mode === "locked"
    ? `locked:${row.asset_id}`
    : row.primary_content_ref
  return {
    asset_id: row.asset_id,
    community_id: row.community_id,
    source_post_id: row.source_post_id,
    song_artifact_bundle_id: row.song_artifact_bundle_id,
    creator_user_id: row.creator_user_id,
    asset_kind: row.asset_kind,
    rights_basis: row.rights_basis,
    access_mode: row.access_mode,
    primary_content_ref: primaryContentRef,
    primary_content_hash: row.primary_content_hash,
    publication_status: row.publication_status,
    story_status: row.story_status,
    story_error: row.story_error,
    story_ip_id: row.story_ip_id,
    story_publish_tx_ref: row.story_publish_tx_ref,
    story_asset_version_id: row.story_asset_version_id,
    story_cdr_vault_uuid: row.story_cdr_vault_uuid,
    story_namespace: row.story_namespace,
    story_entitlement_token_id: row.story_entitlement_token_id,
    story_read_condition: row.story_read_condition,
    story_write_condition: row.story_write_condition,
    locked_delivery_status: row.locked_delivery_status,
    locked_delivery_ref: row.locked_delivery_ref,
    locked_delivery_error: row.locked_delivery_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function serializeListing(row: ListingRow): CommunityListing {
  return {
    listing_id: row.listing_id,
    community_id: row.community_id,
    asset_id: row.asset_id,
    live_room_id: row.live_room_id,
    listing_mode: row.listing_mode,
    status: row.status,
    price_usd: row.price_usd,
    regional_pricing_enabled: parseJsonValue<{ regional_pricing_enabled?: boolean }>(
      row.regional_pricing_policy_json,
      {},
    ).regional_pricing_enabled === true,
    created_by_user_id: row.created_by_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function serializeQuote(row: PurchaseQuoteRow): CommunityPurchaseQuote {
  const settlementChain = parseJsonValue<CommunityPurchaseQuote["destination_settlement_chain"]>(
    row.destination_settlement_chain_json,
    { chain_namespace: "eip155", chain_id: 1315, display_name: "Story Aeneid" },
  )
  return {
    quote_id: row.quote_id,
    community_id: row.community_id,
    listing_id: row.listing_id,
    buyer_user_id: row.buyer_user_id,
    asset_id: row.asset_id,
    live_room_id: row.live_room_id,
    base_price_usd: row.base_price_usd,
    pricing_tier: row.pricing_tier,
    final_price_usd: row.final_price_usd,
    funding_mode: row.funding_mode,
    funding_asset: parseJsonValue(row.funding_asset_json, null),
    source_chain: parseJsonValue(row.source_chain_json, null),
    route_provider: row.route_provider,
    route_policy_compliant: row.route_policy_compliant,
    route_live_available: row.route_live_available,
    policy_origin: row.policy_origin,
    destination_settlement_chain: settlementChain,
    destination_settlement_token: row.destination_settlement_token,
    treasury_denomination: row.treasury_denomination,
    quote_ttl_seconds: row.quote_ttl_seconds,
    route_required: row.route_required,
    route_status_policy: row.route_status_policy,
    route_hop_tolerance: row.route_hop_tolerance,
    verification_snapshot_ref: row.verification_snapshot_ref,
    pricing_policy_version: row.pricing_policy_version,
    quoted_at: row.quoted_at,
    expires_at: row.expires_at,
  }
}

function serializePurchase(row: PurchaseRow, entitlement: PurchaseEntitlementRow): CommunityPurchase {
  const settlementChain = parseJsonValue<CommunityPurchase["settlement_chain"]>(
    row.settlement_chain,
    { chain_namespace: "eip155", chain_id: 1315, display_name: "Story Aeneid" },
  )
  return {
    purchase_id: row.purchase_id,
    community_id: row.community_id,
    listing_id: row.listing_id,
    asset_id: row.asset_id,
    live_room_id: row.live_room_id,
    buyer_user_id: row.buyer_user_id,
    settlement_wallet_attachment_id: row.settlement_wallet_attachment_id,
    purchase_price_usd: row.purchase_price_usd,
    pricing_tier: row.pricing_tier,
    settlement_chain: settlementChain,
    settlement_token: row.settlement_token,
    settlement_tx_ref: row.settlement_tx_ref,
    purchase_entitlement_id: entitlement.purchase_entitlement_id,
    entitlement_kind: entitlement.entitlement_kind,
    entitlement_target_ref: entitlement.target_ref,
    created_at: row.created_at,
  }
}

function serializeSettlement(
  purchase: PurchaseRow,
  entitlement: PurchaseEntitlementRow,
  quote: PurchaseQuoteRow,
): CommunityPurchaseSettlement {
  const settlementChain = parseJsonValue<CommunityPurchaseSettlement["settlement_chain"]>(
    purchase.settlement_chain,
    { chain_namespace: "eip155", chain_id: 1315, display_name: "Story Aeneid" },
  )
  return {
    purchase_id: purchase.purchase_id,
    quote_id: quote.quote_id,
    community_id: purchase.community_id,
    listing_id: purchase.listing_id,
    buyer_user_id: purchase.buyer_user_id,
    asset_id: purchase.asset_id,
    live_room_id: purchase.live_room_id,
    settlement_wallet_attachment_id: purchase.settlement_wallet_attachment_id,
    purchase_price_usd: purchase.purchase_price_usd,
    pricing_tier: purchase.pricing_tier,
    settlement_chain: settlementChain,
    settlement_chain_ref: toChainRefString(settlementChain),
    settlement_token: purchase.settlement_token,
    settlement_tx_ref: purchase.settlement_tx_ref,
    entitlement_kind: toSettlementEntitlementKind(entitlement.entitlement_kind),
    entitlement_target_ref: entitlement.target_ref,
    purchase_entitlement_id: entitlement.purchase_entitlement_id,
    settled_at: purchase.created_at,
  }
}

async function requireCommunityMember(client: Client, communityId: string, userId: string): Promise<void> {
  const membership = await getCommunityMembershipState(client, communityId, userId)
  if (membership.membership_status !== "member" && membership.role_status !== "active") {
    throw notFoundError("Community not found")
  }
}

async function requireCommunityOwner(input: {
  communityId: string
  userId: string
  communityRepository: CommunityRepository
}): Promise<void> {
  const community = await input.communityRepository.getCommunityById(input.communityId)
  if (!community || community.creator_user_id !== input.userId) {
    throw notFoundError("Community not found")
  }
}

async function requireVerifiedHuman(userRepository: UserRepository, userId: string): Promise<void> {
  const user = await userRepository.getUserById(userId)
  if (!user) {
    throw notFoundError("User not found")
  }
  if (user.verification_capabilities.unique_human.state !== "verified") {
    throw verificationRequired("unique_human verification is required")
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100
}

function toOwnedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes)
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

function toSettlementEntitlementKind(
  entitlementKind: CommunityPurchase["entitlement_kind"],
): CommunityPurchaseSettlement["entitlement_kind"] {
  return entitlementKind === "live_room_access" ? "live_room_access" : "asset_access"
}

async function encryptLockedPayload(bytes: Uint8Array): Promise<{
  ciphertext: Uint8Array
  dataKey: Uint8Array
  metadata: LockedDeliverySecret
}> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, toOwnedBytes(bytes)),
  )
  return {
    ciphertext,
    dataKey: keyBytes,
    metadata: {
      algorithm: "AES-GCM",
      iv_b64: toBase64(iv),
      mime_type: "audio/mpeg",
    },
  }
}

function buildAssetContentPath(communityId: string, assetId: string): string {
  return `/communities/${encodeURIComponent(communityId)}/assets/${encodeURIComponent(assetId)}/content`
}

async function resolvePrimaryWalletAddress(input: {
  env: Env
  userRepository: UserRepository
  userId: string
}): Promise<string> {
  const user = await input.userRepository.getUserById(input.userId)
  if (!user) {
    throw notFoundError("User not found")
  }
  const attachments = await input.userRepository.getWalletAttachmentsByUserId(input.userId)
  const address = getPrimaryWalletSnapshot(user, attachments)
  if (!address?.trim()) {
    const operatorAddress = String(input.env.STORY_OPERATOR_PKP_ADDRESS || "").trim()
    if (operatorAddress) {
      return operatorAddress
    }
    const writerAddress = String(input.env.STORY_CDR_WRITER_PKP_ADDRESS || "").trim()
    if (writerAddress) {
      return writerAddress
    }
    throw badRequestError("Primary wallet is required")
  }
  return address
}

function encodeStoryAccessAuxData(input: {
  vaultUuid: number
  caller: string
  accessRef: `0x${string}`
  scope: `0x${string}`
  expiry: number
  namespace: `0x${string}`
  signature: `0x${string}`
}): `0x${string}` {
  return abiCoder.encode(
    [
      "tuple(uint32 vaultUuid,address caller,bytes32 accessRef,bytes32 scope,uint64 expiry,bytes32 namespace)",
      "bytes",
    ],
    [
      {
        vaultUuid: input.vaultUuid,
        caller: input.caller,
        accessRef: input.accessRef,
        scope: input.scope,
        expiry: input.expiry,
        namespace: input.namespace,
      },
      input.signature,
    ],
  ) as `0x${string}`
}

function buildStoryAccessRef(input: {
  communityId: string
  assetId: string
  userId: string
  decisionReason: AssetAccessResponse["decision_reason"]
}): `0x${string}` {
  return hashBytes32FromParts(
    "pirate-v2",
    "story-access",
    input.communityId,
    input.assetId,
    input.userId,
    input.decisionReason,
  )
}

async function buildStoryCdrAccessPackage(input: {
  env: Env
  asset: AssetRow
  callerWalletAddress: string
  userId: string
  decisionReason: "creator" | "moderator" | "purchase_entitlement"
}): Promise<NonNullable<AssetAccessResponse["story_cdr_access"]>> {
  if (!input.asset.story_cdr_vault_uuid || !input.asset.story_namespace || !input.asset.locked_delivery_secret_json) {
    throw notFoundError("Locked asset CDR metadata not found")
  }
  const chainId = resolveStoryChainId(input.env)
  const cdrContracts = resolveStoryCdrContracts(chainId)
  if (!cdrContracts) {
    throw badRequestError("Story CDR contracts are not configured for this chain")
  }
  const metadata = parseJsonValue<LockedDeliverySecret>(input.asset.locked_delivery_secret_json, {
    algorithm: "AES-GCM",
    iv_b64: "",
    mime_type: "application/octet-stream",
  })
  const accessScope: StoryAccessScope = input.decisionReason === "purchase_entitlement" ? "asset.share" : "asset.owner"
  const accessRef = buildStoryAccessRef({
    communityId: input.asset.community_id,
    assetId: input.asset.asset_id,
    userId: input.userId,
    decisionReason: input.decisionReason,
  })
  const accessProof = await generateStorySignedAccessProof({
    env: input.env,
    vaultUuid: input.asset.story_cdr_vault_uuid,
    callerAddress: input.callerWalletAddress,
    accessRef,
    scope: accessScope,
    expiry: Math.floor(Date.now() / 1000) + 300,
    namespace: input.asset.story_namespace as `0x${string}`,
    verifyingContract: STORY_DELIVERY_CONTRACTS.signedAccessConditionV1,
  })

  return {
    chain_id: chainId,
    rpc_url: resolveStoryRpcUrl(input.env),
    cdr_contract_address: cdrContracts.cdrAddress,
    read_condition_address: STORY_DELIVERY_CONTRACTS.signedAccessConditionV1,
    ciphertext_ref: buildAssetContentPath(input.asset.community_id, input.asset.asset_id),
    cipher_algorithm: metadata.algorithm,
    cipher_iv_b64: metadata.iv_b64,
    mime_type: metadata.mime_type,
    vault_uuid: input.asset.story_cdr_vault_uuid,
    namespace: input.asset.story_namespace,
    access_scope: accessScope,
    access_aux_data_hex: encodeStoryAccessAuxData({
      vaultUuid: accessProof.proof.vaultUuid,
      caller: accessProof.proof.caller,
      accessRef: accessProof.proof.accessRef,
      scope: accessProof.proof.scope,
      expiry: accessProof.proof.expiry,
      namespace: accessProof.proof.namespace,
      signature: accessProof.signature,
    }),
    access_proof: {
      digest: accessProof.digest,
      signature: accessProof.signature,
      signer_address: accessProof.signerAddress,
      caller: accessProof.proof.caller,
      access_ref: accessProof.proof.accessRef,
      scope: accessProof.proof.scope,
      expiry: accessProof.proof.expiry,
      namespace: accessProof.proof.namespace,
    },
  }
}

async function getAssetRow(client: Client, communityId: string, assetId: string): Promise<AssetRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT asset_id, community_id, source_post_id, song_artifact_bundle_id, creator_user_id, asset_kind,
             rights_basis, access_mode, primary_content_ref, primary_content_hash, publication_status,
             story_status, story_error, story_ip_id, story_publish_tx_ref, story_asset_version_id,
             story_cdr_vault_uuid, story_namespace, story_entitlement_token_id, story_read_condition,
             story_write_condition, locked_delivery_status, locked_delivery_ref, locked_delivery_error,
             locked_delivery_storage_ref, locked_delivery_secret_json, created_at, updated_at
      FROM assets
      WHERE community_id = ?1
        AND asset_id = ?2
      LIMIT 1
    `,
    args: [communityId, assetId],
  })
  if (!row) {
    return null
  }
  return {
    asset_id: requiredString(row, "asset_id"),
    community_id: requiredString(row, "community_id"),
    source_post_id: requiredString(row, "source_post_id"),
    song_artifact_bundle_id: stringOrNull(row, "song_artifact_bundle_id"),
    creator_user_id: requiredString(row, "creator_user_id"),
    asset_kind: requiredString(row, "asset_kind") as Asset["asset_kind"],
    rights_basis: requiredString(row, "rights_basis") as Asset["rights_basis"],
    access_mode: requiredString(row, "access_mode") as Asset["access_mode"],
    primary_content_ref: requiredString(row, "primary_content_ref"),
    primary_content_hash: stringOrNull(row, "primary_content_hash"),
    publication_status: requiredString(row, "publication_status") as Asset["publication_status"],
    story_status: requiredString(row, "story_status") as Asset["story_status"],
    story_error: stringOrNull(row, "story_error"),
    story_ip_id: stringOrNull(row, "story_ip_id"),
    story_publish_tx_ref: stringOrNull(row, "story_publish_tx_ref"),
    story_asset_version_id: stringOrNull(row, "story_asset_version_id"),
    story_cdr_vault_uuid: numberOrNull(row, "story_cdr_vault_uuid"),
    story_namespace: stringOrNull(row, "story_namespace"),
    story_entitlement_token_id: stringOrNull(row, "story_entitlement_token_id"),
    story_read_condition: stringOrNull(row, "story_read_condition"),
    story_write_condition: stringOrNull(row, "story_write_condition"),
    locked_delivery_status: requiredString(row, "locked_delivery_status") as Asset["locked_delivery_status"],
    locked_delivery_ref: stringOrNull(row, "locked_delivery_ref"),
    locked_delivery_error: stringOrNull(row, "locked_delivery_error"),
    locked_delivery_storage_ref: stringOrNull(row, "locked_delivery_storage_ref"),
    locked_delivery_secret_json: stringOrNull(row, "locked_delivery_secret_json"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

async function getListingRowById(client: Client, communityId: string, listingId: string): Promise<ListingRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT listing_id, community_id, asset_id, live_room_id, listing_mode, status, price_usd,
             regional_pricing_policy_json, created_by_user_id, created_at, updated_at
      FROM listings
      WHERE community_id = ?1
        AND listing_id = ?2
      LIMIT 1
    `,
    args: [communityId, listingId],
  })
  if (!row) {
    return null
  }
  return {
    listing_id: requiredString(row, "listing_id"),
    community_id: requiredString(row, "community_id"),
    asset_id: stringOrNull(row, "asset_id"),
    live_room_id: stringOrNull(row, "live_room_id"),
    listing_mode: requiredString(row, "listing_mode") as CommunityListing["listing_mode"],
    status: requiredString(row, "status") as CommunityListing["status"],
    price_usd: Number(numberOrNull(row, "price_usd") ?? 0),
    regional_pricing_policy_json: stringOrNull(row, "regional_pricing_policy_json"),
    created_by_user_id: requiredString(row, "created_by_user_id"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

async function getListingRowByAssetId(client: Client, communityId: string, assetId: string): Promise<ListingRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT listing_id, community_id, asset_id, live_room_id, listing_mode, status, price_usd,
             regional_pricing_policy_json, created_by_user_id, created_at, updated_at
      FROM listings
      WHERE community_id = ?1
        AND asset_id = ?2
      ORDER BY created_at DESC
      LIMIT 1
    `,
    args: [communityId, assetId],
  })
  return row ? {
    listing_id: requiredString(row, "listing_id"),
    community_id: requiredString(row, "community_id"),
    asset_id: stringOrNull(row, "asset_id"),
    live_room_id: stringOrNull(row, "live_room_id"),
    listing_mode: requiredString(row, "listing_mode") as CommunityListing["listing_mode"],
    status: requiredString(row, "status") as CommunityListing["status"],
    price_usd: Number(numberOrNull(row, "price_usd") ?? 0),
    regional_pricing_policy_json: stringOrNull(row, "regional_pricing_policy_json"),
    created_by_user_id: requiredString(row, "created_by_user_id"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  } : null
}

async function listListingRows(client: Client, communityId: string): Promise<ListingRow[]> {
  const result = await client.execute({
    sql: `
      SELECT listing_id, community_id, asset_id, live_room_id, listing_mode, status, price_usd,
             regional_pricing_policy_json, created_by_user_id, created_at, updated_at
      FROM listings
      WHERE community_id = ?1
      ORDER BY created_at DESC
    `,
    args: [communityId],
  })
  return result.rows.map((row) => ({
    listing_id: requiredString(row, "listing_id"),
    community_id: requiredString(row, "community_id"),
    asset_id: stringOrNull(row, "asset_id"),
    live_room_id: stringOrNull(row, "live_room_id"),
    listing_mode: requiredString(row, "listing_mode") as CommunityListing["listing_mode"],
    status: requiredString(row, "status") as CommunityListing["status"],
    price_usd: Number(numberOrNull(row, "price_usd") ?? 0),
    regional_pricing_policy_json: stringOrNull(row, "regional_pricing_policy_json"),
    created_by_user_id: requiredString(row, "created_by_user_id"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }))
}

async function getActiveEntitlementForBuyer(
  client: Client,
  communityId: string,
  userId: string,
  targetRef: string,
): Promise<PurchaseEntitlementRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT purchase_entitlement_id, purchase_id, community_id, buyer_user_id, entitlement_kind,
             target_ref, status, granted_at, revoked_at, created_at, updated_at
      FROM purchase_entitlements
      WHERE community_id = ?1
        AND buyer_user_id = ?2
        AND target_ref = ?3
        AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    args: [communityId, userId, targetRef],
  })
  return row ? {
    purchase_entitlement_id: requiredString(row, "purchase_entitlement_id"),
    purchase_id: requiredString(row, "purchase_id"),
    community_id: requiredString(row, "community_id"),
    buyer_user_id: requiredString(row, "buyer_user_id"),
    entitlement_kind: requiredString(row, "entitlement_kind") as CommunityPurchase["entitlement_kind"],
    target_ref: requiredString(row, "target_ref"),
    status: requiredString(row, "status") as PurchaseEntitlementRow["status"],
    granted_at: requiredString(row, "granted_at"),
    revoked_at: stringOrNull(row, "revoked_at"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  } : null
}

async function getPurchaseQuoteRow(
  client: Client,
  communityId: string,
  quoteId: string,
): Promise<PurchaseQuoteRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT quote_id, community_id, listing_id, buyer_user_id, asset_id, live_room_id, base_price_usd,
             pricing_tier, final_price_usd, funding_mode, funding_asset_json, source_chain_json,
             route_provider, route_policy_compliant, route_live_available, policy_origin,
             destination_settlement_chain_json, destination_settlement_token, treasury_denomination,
             quote_ttl_seconds, route_required, route_status_policy, route_hop_tolerance,
             verification_snapshot_ref, pricing_policy_version, status, quoted_at, expires_at,
             consumed_at, failed_at, created_at, updated_at
      FROM purchase_quotes
      WHERE community_id = ?1
        AND quote_id = ?2
      LIMIT 1
    `,
    args: [communityId, quoteId],
  })
  return row ? {
    quote_id: requiredString(row, "quote_id"),
    community_id: requiredString(row, "community_id"),
    listing_id: requiredString(row, "listing_id"),
    buyer_user_id: requiredString(row, "buyer_user_id"),
    asset_id: stringOrNull(row, "asset_id"),
    live_room_id: stringOrNull(row, "live_room_id"),
    base_price_usd: Number(numberOrNull(row, "base_price_usd") ?? 0),
    pricing_tier: stringOrNull(row, "pricing_tier"),
    final_price_usd: Number(numberOrNull(row, "final_price_usd") ?? 0),
    funding_mode: requiredString(row, "funding_mode") as PurchaseQuoteRow["funding_mode"],
    funding_asset_json: stringOrNull(row, "funding_asset_json"),
    source_chain_json: stringOrNull(row, "source_chain_json"),
    route_provider: stringOrNull(row, "route_provider"),
    route_policy_compliant: sqliteToBool((row as Record<string, unknown>).route_policy_compliant),
    route_live_available: (row as Record<string, unknown>).route_live_available == null
      ? null
      : sqliteToBool((row as Record<string, unknown>).route_live_available),
    policy_origin: requiredString(row, "policy_origin") as CommunityMoneyPolicy["policy_origin"],
    destination_settlement_chain_json: requiredString(row, "destination_settlement_chain_json"),
    destination_settlement_token: requiredString(row, "destination_settlement_token"),
    treasury_denomination: stringOrNull(row, "treasury_denomination"),
    quote_ttl_seconds: Number(numberOrNull(row, "quote_ttl_seconds") ?? 0),
    route_required: sqliteToBool((row as Record<string, unknown>).route_required),
    route_status_policy: requiredString(row, "route_status_policy") as CommunityMoneyPolicy["route_status_policy"],
    route_hop_tolerance: Number(numberOrNull(row, "route_hop_tolerance") ?? 0),
    verification_snapshot_ref: stringOrNull(row, "verification_snapshot_ref"),
    pricing_policy_version: stringOrNull(row, "pricing_policy_version"),
    status: requiredString(row, "status") as PurchaseQuoteRow["status"],
    quoted_at: requiredString(row, "quoted_at"),
    expires_at: requiredString(row, "expires_at"),
    consumed_at: stringOrNull(row, "consumed_at"),
    failed_at: stringOrNull(row, "failed_at"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  } : null
}

async function listPurchaseRows(client: Client, communityId: string, userId: string): Promise<PurchaseRow[]> {
  const result = await client.execute({
    sql: `
      SELECT purchase_id, community_id, listing_id, asset_id, live_room_id, buyer_user_id,
             settlement_wallet_attachment_id, purchase_price_usd, pricing_tier, settlement_chain,
             settlement_token, settlement_tx_ref, created_at
      FROM purchases
      WHERE community_id = ?1
        AND buyer_user_id = ?2
      ORDER BY created_at DESC
    `,
    args: [communityId, userId],
  })
  return result.rows.map((row) => ({
    purchase_id: requiredString(row, "purchase_id"),
    community_id: requiredString(row, "community_id"),
    listing_id: requiredString(row, "listing_id"),
    asset_id: stringOrNull(row, "asset_id"),
    live_room_id: stringOrNull(row, "live_room_id"),
    buyer_user_id: requiredString(row, "buyer_user_id"),
    settlement_wallet_attachment_id: requiredString(row, "settlement_wallet_attachment_id"),
    purchase_price_usd: Number(numberOrNull(row, "purchase_price_usd") ?? 0),
    pricing_tier: stringOrNull(row, "pricing_tier"),
    settlement_chain: requiredString(row, "settlement_chain"),
    settlement_token: requiredString(row, "settlement_token"),
    settlement_tx_ref: requiredString(row, "settlement_tx_ref"),
    created_at: requiredString(row, "created_at"),
  }))
}

async function getPurchaseRow(client: Client, communityId: string, purchaseId: string): Promise<PurchaseRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT purchase_id, community_id, listing_id, asset_id, live_room_id, buyer_user_id,
             settlement_wallet_attachment_id, purchase_price_usd, pricing_tier, settlement_chain,
             settlement_token, settlement_tx_ref, created_at
      FROM purchases
      WHERE community_id = ?1
        AND purchase_id = ?2
      LIMIT 1
    `,
    args: [communityId, purchaseId],
  })
  return row ? {
    purchase_id: requiredString(row, "purchase_id"),
    community_id: requiredString(row, "community_id"),
    listing_id: requiredString(row, "listing_id"),
    asset_id: stringOrNull(row, "asset_id"),
    live_room_id: stringOrNull(row, "live_room_id"),
    buyer_user_id: requiredString(row, "buyer_user_id"),
    settlement_wallet_attachment_id: requiredString(row, "settlement_wallet_attachment_id"),
    purchase_price_usd: Number(numberOrNull(row, "purchase_price_usd") ?? 0),
    pricing_tier: stringOrNull(row, "pricing_tier"),
    settlement_chain: requiredString(row, "settlement_chain"),
    settlement_token: requiredString(row, "settlement_token"),
    settlement_tx_ref: requiredString(row, "settlement_tx_ref"),
    created_at: requiredString(row, "created_at"),
  } : null
}

async function getEntitlementRowByPurchase(client: Client, purchaseId: string): Promise<PurchaseEntitlementRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT purchase_entitlement_id, purchase_id, community_id, buyer_user_id, entitlement_kind,
             target_ref, status, granted_at, revoked_at, created_at, updated_at
      FROM purchase_entitlements
      WHERE purchase_id = ?1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    args: [purchaseId],
  })
  return row ? {
    purchase_entitlement_id: requiredString(row, "purchase_entitlement_id"),
    purchase_id: requiredString(row, "purchase_id"),
    community_id: requiredString(row, "community_id"),
    buyer_user_id: requiredString(row, "buyer_user_id"),
    entitlement_kind: requiredString(row, "entitlement_kind") as CommunityPurchase["entitlement_kind"],
    target_ref: requiredString(row, "target_ref"),
    status: requiredString(row, "status") as PurchaseEntitlementRow["status"],
    granted_at: requiredString(row, "granted_at"),
    revoked_at: stringOrNull(row, "revoked_at"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  } : null
}

function defaultMoneyPolicy(communityId: string): CommunityMoneyPolicy {
  return {
    community_id: communityId,
    policy_origin: "default",
    funding_preference: "WIP",
    accepted_funding_assets: [{
      asset_symbol: "WIP",
      chain_namespace: "eip155",
      chain_id: 1315,
      display_name: "WIP",
    }],
    accepted_source_chains: [{
      chain_namespace: "eip155",
      chain_id: 1315,
      display_name: "Story Aeneid",
    }],
    approved_route_providers: null,
    destination_settlement_chain: {
      chain_namespace: "eip155",
      chain_id: 1315,
      display_name: "Story Aeneid",
    },
    destination_settlement_token: "WIP",
    treasury_denomination: "WIP",
    max_slippage_bps: 150,
    quote_ttl_seconds: 900,
    route_required: false,
    route_status_policy: "fail",
    route_hop_tolerance: 0,
    updated_at: new Date(0).toISOString(),
  }
}

function defaultPricingPolicy(communityId: string): CommunityPricingPolicy {
  return {
    community_id: communityId,
    policy_origin: "default",
    pricing_policy_version: "default",
    regional_pricing_enabled: false,
    verification_provider_requirement: null,
    default_tier_key: null,
    tiers: [],
    country_assignments: [],
    source_template_id: null,
    source_template_version: null,
    updated_at: new Date(0).toISOString(),
  }
}

export async function getCommunityMoneyPolicy(input: {
  env: Env
  communityId: string
}): Promise<CommunityMoneyPolicy> {
  const client = getControlPlaneClient(input.env)
  const row = await executeFirst(client, {
    sql: `
      SELECT community_id, funding_preference, accepted_funding_assets_json, accepted_source_chains_json,
             approved_route_providers_json, destination_settlement_chain_json, destination_settlement_token,
             treasury_denomination, max_slippage_bps, quote_ttl_seconds, route_required, route_status_policy,
             route_hop_tolerance, updated_at
      FROM community_money_policies
      WHERE community_id = ?1
      LIMIT 1
    `,
    args: [input.communityId],
  })
  if (!row) {
    return defaultMoneyPolicy(input.communityId)
  }
  return {
    community_id: requiredString(row, "community_id"),
    policy_origin: "explicit",
    funding_preference: requiredString(row, "funding_preference"),
    accepted_funding_assets: parseJsonValue(requiredString(row, "accepted_funding_assets_json"), []),
    accepted_source_chains: parseJsonValue(requiredString(row, "accepted_source_chains_json"), []),
    approved_route_providers: parseJsonValue(stringOrNull(row, "approved_route_providers_json"), null),
    destination_settlement_chain: parseJsonValue(requiredString(row, "destination_settlement_chain_json"), {
      chain_namespace: "eip155",
      chain_id: 1315,
      display_name: "Story Aeneid",
    }),
    destination_settlement_token: requiredString(row, "destination_settlement_token"),
    treasury_denomination: stringOrNull(row, "treasury_denomination"),
    max_slippage_bps: Number(numberOrNull(row, "max_slippage_bps") ?? 0),
    quote_ttl_seconds: Number(numberOrNull(row, "quote_ttl_seconds") ?? 0),
    route_required: sqliteToBool((row as Record<string, unknown>).route_required),
    route_status_policy: requiredString(row, "route_status_policy") as CommunityMoneyPolicy["route_status_policy"],
    route_hop_tolerance: Number(numberOrNull(row, "route_hop_tolerance") ?? 0),
    updated_at: requiredString(row, "updated_at"),
  }
}

export async function updateCommunityMoneyPolicy(input: {
  env: Env
  userId: string
  communityId: string
  body: UpdateCommunityMoneyPolicyRequest
  communityRepository: CommunityRepository
}): Promise<CommunityMoneyPolicy> {
  await requireCommunityOwner({
    communityId: input.communityId,
    userId: input.userId,
    communityRepository: input.communityRepository,
  })
  const client = getControlPlaneClient(input.env)
  const updatedAt = nowIso()
  await client.execute({
    sql: `
      INSERT INTO community_money_policies (
        community_id, funding_preference, accepted_funding_assets_json, accepted_source_chains_json,
        approved_route_providers_json, destination_settlement_chain_json, destination_settlement_token,
        treasury_denomination, max_slippage_bps, quote_ttl_seconds, route_required, route_status_policy,
        route_hop_tolerance, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4,
        ?5, ?6, ?7,
        ?8, ?9, ?10, ?11, ?12,
        ?13, ?14
      )
      ON CONFLICT(community_id) DO UPDATE SET
        funding_preference = excluded.funding_preference,
        accepted_funding_assets_json = excluded.accepted_funding_assets_json,
        accepted_source_chains_json = excluded.accepted_source_chains_json,
        approved_route_providers_json = excluded.approved_route_providers_json,
        destination_settlement_chain_json = excluded.destination_settlement_chain_json,
        destination_settlement_token = excluded.destination_settlement_token,
        treasury_denomination = excluded.treasury_denomination,
        max_slippage_bps = excluded.max_slippage_bps,
        quote_ttl_seconds = excluded.quote_ttl_seconds,
        route_required = excluded.route_required,
        route_status_policy = excluded.route_status_policy,
        route_hop_tolerance = excluded.route_hop_tolerance,
        updated_at = excluded.updated_at
    `,
    args: [
      input.communityId,
      input.body.funding_preference,
      JSON.stringify(input.body.accepted_funding_assets),
      JSON.stringify(input.body.accepted_source_chains),
      input.body.approved_route_providers ? JSON.stringify(input.body.approved_route_providers) : null,
      JSON.stringify(input.body.destination_settlement_chain),
      input.body.destination_settlement_token,
      input.body.treasury_denomination ?? null,
      input.body.max_slippage_bps,
      input.body.quote_ttl_seconds,
      boolToSqlite(input.body.route_required),
      input.body.route_status_policy,
      input.body.route_hop_tolerance,
      updatedAt,
    ],
  })
  return await getCommunityMoneyPolicy({ env: input.env, communityId: input.communityId })
}

export async function getCommunityPricingPolicy(input: {
  env: Env
  communityId: string
}): Promise<CommunityPricingPolicy> {
  const client = getControlPlaneClient(input.env)
  const row = await executeFirst(client, {
    sql: `
      SELECT community_id, regional_pricing_enabled, verification_provider_requirement, default_tier_key,
             tiers_json, country_assignments_json, source_template_id, source_template_version,
             pricing_policy_version, updated_at
      FROM community_pricing_policies
      WHERE community_id = ?1
      LIMIT 1
    `,
    args: [input.communityId],
  })
  if (!row) {
    return defaultPricingPolicy(input.communityId)
  }
  return {
    community_id: requiredString(row, "community_id"),
    policy_origin: "explicit",
    pricing_policy_version: requiredString(row, "pricing_policy_version"),
    regional_pricing_enabled: sqliteToBool((row as Record<string, unknown>).regional_pricing_enabled),
    verification_provider_requirement: stringOrNull(row, "verification_provider_requirement") as CommunityPricingPolicy["verification_provider_requirement"],
    default_tier_key: stringOrNull(row, "default_tier_key"),
    tiers: parseJsonValue(requiredString(row, "tiers_json"), []),
    country_assignments: parseJsonValue(requiredString(row, "country_assignments_json"), []),
    source_template_id: stringOrNull(row, "source_template_id"),
    source_template_version: stringOrNull(row, "source_template_version"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export async function updateCommunityPricingPolicy(input: {
  env: Env
  userId: string
  communityId: string
  body: UpdateCommunityPricingPolicyRequest
  communityRepository: CommunityRepository
}): Promise<CommunityPricingPolicy> {
  await requireCommunityOwner({
    communityId: input.communityId,
    userId: input.userId,
    communityRepository: input.communityRepository,
  })
  const client = getControlPlaneClient(input.env)
  const updatedAt = nowIso()
  const policyVersion = `cpp_${updatedAt}`
  await client.execute({
    sql: `
      INSERT INTO community_pricing_policies (
        community_id, regional_pricing_enabled, verification_provider_requirement, default_tier_key,
        tiers_json, country_assignments_json, source_template_id, source_template_version,
        pricing_policy_version, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4,
        ?5, ?6, ?7, ?8,
        ?9, ?10
      )
      ON CONFLICT(community_id) DO UPDATE SET
        regional_pricing_enabled = excluded.regional_pricing_enabled,
        verification_provider_requirement = excluded.verification_provider_requirement,
        default_tier_key = excluded.default_tier_key,
        tiers_json = excluded.tiers_json,
        country_assignments_json = excluded.country_assignments_json,
        source_template_id = excluded.source_template_id,
        source_template_version = excluded.source_template_version,
        pricing_policy_version = excluded.pricing_policy_version,
        updated_at = excluded.updated_at
    `,
    args: [
      input.communityId,
      boolToSqlite(input.body.regional_pricing_enabled),
      input.body.verification_provider_requirement ?? null,
      input.body.default_tier_key ?? null,
      JSON.stringify(input.body.tiers),
      JSON.stringify(input.body.country_assignments),
      input.body.source_template_id ?? null,
      input.body.source_template_version ?? null,
      policyVersion,
      updatedAt,
    ],
  })
  return await getCommunityPricingPolicy({ env: input.env, communityId: input.communityId })
}

async function prepareLockedSongAssetDelivery(input: {
  env: Env
  communityId: string
  assetId: string
  creatorWalletAddress: string
  bundle: SongArtifactBundle
}): Promise<{
  storyStatus: Asset["story_status"]
  storyPublishTxRef: string
  storyAssetVersionId: string
  storyCdrVaultUuid: number
  storyNamespace: string
  storyEntitlementTokenId: string
  storyReadCondition: string
  storyWriteCondition: string
  lockedDeliveryStatus: Asset["locked_delivery_status"]
  lockedDeliveryRef: string
  lockedDeliveryStorageRef: string
  lockedDeliveryMetadataJson: string
}> {
  const controlPlaneClient = getControlPlaneClient(input.env)
  const upload = await findUploadedSongArtifactByStorageRef({
    client: controlPlaneClient,
    communityId: input.communityId,
    storageRef: input.bundle.primary_audio.storage_ref,
    artifactKind: "primary_audio",
  })
  if (!upload?.storage_object_key) {
    throw badRequestError("Primary audio upload is missing locked-delivery storage metadata")
  }
  const upstream = await fetchSongArtifactBytes({
    env: input.env,
    objectKey: upload.storage_object_key,
  })
  const plaintext = new Uint8Array(await upstream.arrayBuffer())
  const { ciphertext, dataKey, metadata } = await encryptLockedPayload(plaintext)
  metadata.mime_type = input.bundle.primary_audio.mime_type

  const objectKey = `locked-assets/${input.communityId}/${input.assetId}/payload.bin`
  await uploadFilebaseObject({
    env: input.env,
    objectKey,
    mimeType: "application/octet-stream",
    bytes: ciphertext,
  })
  const primaryContentHash = (input.bundle.primary_audio.content_hash?.trim() || `0x${await sha256Hex(plaintext)}`) as `0x${string}`
  const assetVersionId = deriveStoryAssetVersionId({
    communityId: input.communityId,
    assetId: input.assetId,
    bundleId: input.bundle.song_artifact_bundle_id,
    primaryContentHash,
  })
  const namespace = deriveStoryNamespace(assetVersionId)
  const entitlementTokenId = deriveEntitlementTokenId(assetVersionId)
  const readConditionAddress = STORY_DELIVERY_CONTRACTS.signedAccessConditionV1
  const writeConditionAddress = STORY_DELIVERY_CONTRACTS.signedAccessConditionV1
  const writerConfig = resolveStoryCdrWriterPkpExecutionConfig(input.env)
  if (!writerConfig.ok) {
    throw badRequestError(writerConfig.error)
  }
  if (!writerConfig.value) {
    throw badRequestError("STORY_CDR_WRITER_PKP_ADDRESS missing/invalid")
  }
  const readConditionData = encodeSignedAccessNamespace(namespace)
  const writeConditionData = encodeWriteConditionOperatorData(writerConfig.value.pkp.pkpAddress)
  const cdrUpload = await uploadCdrEncryptedDataKey({
    env: input.env,
    dataKey,
    readConditionAddr: readConditionAddress,
    writeConditionAddr: writeConditionAddress,
    readConditionData,
    writeConditionData,
  })
  const storyPublish = await publishLockedAssetVersionToStory({
    env: input.env,
    publisherAddress: input.creatorWalletAddress,
    assetVersionId,
    cdrVaultUuid: cdrUpload.cdrVaultUuid,
    namespace,
    contentHash: primaryContentHash,
    storageRefHash: deriveStorageRefHash(objectKey),
    entitlementTokenId,
    readConditionAddress,
    writeConditionAddress,
  })
  return {
    storyStatus: "published",
    storyPublishTxRef: storyPublish.publishTxHash,
    storyAssetVersionId: assetVersionId,
    storyCdrVaultUuid: cdrUpload.cdrVaultUuid,
    storyNamespace: namespace,
    storyEntitlementTokenId: entitlementTokenId.toString(),
    storyReadCondition: readConditionAddress,
    storyWriteCondition: writeConditionAddress,
    lockedDeliveryStatus: "ready",
    lockedDeliveryRef: buildAssetContentPath(input.communityId, input.assetId),
    lockedDeliveryStorageRef: objectKey,
    lockedDeliveryMetadataJson: JSON.stringify(metadata),
  }
}

async function fetchPrimarySongAssetContent(input: {
  env: Env
  communityId: string
  storageRef: string
}): Promise<Response> {
  const controlPlaneClient = getControlPlaneClient(input.env)
  const upload = await findUploadedSongArtifactByStorageRef({
    client: controlPlaneClient,
    communityId: input.communityId,
    storageRef: input.storageRef,
    artifactKind: "primary_audio",
  })
  if (!upload?.storage_object_key) {
    throw notFoundError("Primary asset content not found")
  }
  return await fetchSongArtifactBytes({
    env: input.env,
    objectKey: upload.storage_object_key,
  })
}

export async function createSongAssetForPost(input: {
  env: Env
  client: Client
  communityId: string
  post: Post
  bundle: SongArtifactBundle
  userRepository: UserRepository
}): Promise<Asset> {
  if (!input.post.asset_id?.trim()) {
    throw badRequestError("Song post is missing asset_id")
  }
  const existing = await getAssetRow(input.client, input.communityId, input.post.asset_id)
  if (existing) {
    return serializeAsset(existing)
  }
  const createdAt = nowIso()
  let lockedDeliveryStatus: Asset["locked_delivery_status"] = "none"
  let lockedDeliveryRef: string | null = null
  let lockedDeliveryError: string | null = null
  let lockedDeliveryStorageRef: string | null = null
  let lockedDeliveryMetadataJson: string | null = null
  let storyStatus: Asset["story_status"] = "none"
  let storyError: string | null = null
  let storyPublishTxRef: string | null = null
  let storyAssetVersionId: string | null = null
  let storyCdrVaultUuid: number | null = null
  let storyNamespace: string | null = null
  let storyEntitlementTokenId: string | null = null
  let storyReadCondition: string | null = null
  let storyWriteCondition: string | null = null

  if ((input.post.access_mode ?? "public") === "locked") {
    try {
      const creatorWalletAddress = await resolvePrimaryWalletAddress({
        env: input.env,
        userRepository: input.userRepository,
        userId: input.post.author_user_id ?? "",
      })
      const lockedDelivery = await prepareLockedSongAssetDelivery({
        env: input.env,
        communityId: input.communityId,
        assetId: input.post.asset_id,
        creatorWalletAddress,
        bundle: input.bundle,
      })
      storyStatus = lockedDelivery.storyStatus
      storyPublishTxRef = lockedDelivery.storyPublishTxRef
      storyAssetVersionId = lockedDelivery.storyAssetVersionId
      storyCdrVaultUuid = lockedDelivery.storyCdrVaultUuid
      storyNamespace = lockedDelivery.storyNamespace
      storyEntitlementTokenId = lockedDelivery.storyEntitlementTokenId
      storyReadCondition = lockedDelivery.storyReadCondition
      storyWriteCondition = lockedDelivery.storyWriteCondition
      lockedDeliveryStatus = lockedDelivery.lockedDeliveryStatus
      lockedDeliveryRef = lockedDelivery.lockedDeliveryRef
      lockedDeliveryStorageRef = lockedDelivery.lockedDeliveryStorageRef
      lockedDeliveryMetadataJson = lockedDelivery.lockedDeliveryMetadataJson
    } catch (error) {
      storyStatus = "failed"
      storyError = error instanceof Error ? error.message : String(error)
      lockedDeliveryStatus = "failed"
      lockedDeliveryError = storyError
      throw badRequestError(`Locked delivery preparation failed: ${lockedDeliveryError}`)
    }
  }

  await input.client.execute({
    sql: `
      INSERT INTO assets (
        asset_id, community_id, source_post_id, song_artifact_bundle_id, creator_user_id, asset_kind,
        rights_basis, access_mode, primary_content_ref, primary_content_hash, publication_status,
        story_status, story_error, story_ip_id, locked_delivery_status, locked_delivery_ref,
        locked_delivery_error, created_at, updated_at, story_publish_tx_ref, story_asset_version_id,
        story_cdr_vault_uuid, story_namespace, story_entitlement_token_id, story_read_condition,
        story_write_condition, locked_delivery_storage_ref, locked_delivery_secret_json
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, 'song_audio',
        ?6, ?7, ?8, ?9, 'draft',
        ?10, ?11, NULL, ?12, ?13,
        ?14, ?15, ?15, ?16, ?17,
        ?18, ?19, ?20, ?21, ?22,
        ?23, ?24
      )
    `,
    args: [
      input.post.asset_id,
      input.communityId,
      input.post.post_id,
      input.post.song_artifact_bundle_id ?? null,
      input.post.author_user_id ?? "",
      input.post.rights_basis ?? "none",
      input.post.access_mode ?? "public",
      input.bundle.primary_audio.storage_ref,
      input.bundle.primary_audio.content_hash ?? `0x${await sha256Hex(input.bundle.primary_audio.storage_ref)}`,
      storyStatus,
      storyError,
      lockedDeliveryStatus,
      lockedDeliveryRef,
      lockedDeliveryError,
      createdAt,
      storyPublishTxRef,
      storyAssetVersionId,
      storyCdrVaultUuid,
      storyNamespace,
      storyEntitlementTokenId,
      storyReadCondition,
      storyWriteCondition,
      lockedDeliveryStorageRef,
      lockedDeliveryMetadataJson,
    ],
  })
  const asset = await getAssetRow(input.client, input.communityId, input.post.asset_id)
  if (!asset) {
    throw notFoundError("Asset not found")
  }
  return serializeAsset(asset)
}

export async function getCommunityAsset(input: {
  env: Env
  userId: string
  communityId: string
  assetId: string
  communityRepository: CommunityRepository
}): Promise<Asset> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const asset = await getAssetRow(db.client, input.communityId, input.assetId)
    if (!asset) {
      throw notFoundError("Asset not found")
    }
    const post = await getPostById(db.client, asset.source_post_id)
    const isPrivilegedViewer = asset.creator_user_id === input.userId
      || (await getCommunityMembershipState(db.client, input.communityId, input.userId)).role_status === "active"
    if (!post) {
      throw notFoundError("Asset not found")
    }
    if (post.status !== "published" && !isPrivilegedViewer) {
      throw notFoundError("Asset not found")
    }
    return serializeAsset(asset, { redactPrimaryForLocked: !isPrivilegedViewer })
  } finally {
    db.close()
  }
}

export async function resolveCommunityAssetAccess(input: {
  env: Env
  userId: string
  communityId: string
  assetId: string
  communityRepository: CommunityRepository
  userRepository: UserRepository
}): Promise<AssetAccessResponse> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const asset = await getAssetRow(db.client, input.communityId, input.assetId)
    if (!asset) {
      throw notFoundError("Asset not found")
    }
    const post = await getPostById(db.client, asset.source_post_id)
    const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
    const isPrivilegedViewer = asset.creator_user_id === input.userId || membership.role_status === "active"
    if (!post) {
      throw notFoundError("Asset not found")
    }
    if (post.status !== "published" && !isPrivilegedViewer) {
      throw notFoundError("Asset not found")
    }

    if (asset.access_mode === "public") {
      return {
        asset_id: asset.asset_id,
        community_id: asset.community_id,
        source_post_id: asset.source_post_id,
        access_mode: asset.access_mode,
        source_post_status: post.status === "draft" || post.status === "hidden" ? post.status : "published",
        story_status: asset.story_status,
        locked_delivery_status: asset.locked_delivery_status,
        access_granted: true,
        decision_reason: isPrivilegedViewer ? "creator" : "public",
        delivery_kind: "primary_content_ref",
        delivery_ref: buildAssetContentPath(asset.community_id, asset.asset_id),
        story_cdr_access: null,
      }
    }

    if (isPrivilegedViewer) {
      const callerWalletAddress = await resolvePrimaryWalletAddress({
        env: input.env,
        userRepository: input.userRepository,
        userId: input.userId,
      })
      const decisionReason = membership.role_status === "active" && asset.creator_user_id !== input.userId ? "moderator" : "creator"
      return {
        asset_id: asset.asset_id,
        community_id: asset.community_id,
        source_post_id: asset.source_post_id,
        access_mode: asset.access_mode,
        source_post_status: post.status === "draft" || post.status === "hidden" ? post.status : "published",
        story_status: asset.story_status,
        locked_delivery_status: asset.locked_delivery_status,
        access_granted: asset.locked_delivery_status === "ready",
        decision_reason: decisionReason,
        delivery_kind: asset.locked_delivery_status === "ready" ? "story_cdr_ref" : null,
        delivery_ref: asset.locked_delivery_status === "ready" ? buildAssetContentPath(asset.community_id, asset.asset_id) : null,
        story_cdr_access: asset.locked_delivery_status === "ready"
          ? await buildStoryCdrAccessPackage({
            env: input.env,
            asset,
            callerWalletAddress,
            userId: input.userId,
            decisionReason,
          })
          : null,
      }
    }

    const entitlement = await getActiveEntitlementForBuyer(db.client, input.communityId, input.userId, asset.asset_id)
    if (entitlement && asset.locked_delivery_status === "ready") {
      const callerWalletAddress = await resolvePrimaryWalletAddress({
        env: input.env,
        userRepository: input.userRepository,
        userId: input.userId,
      })
      return {
        asset_id: asset.asset_id,
        community_id: asset.community_id,
        source_post_id: asset.source_post_id,
        access_mode: asset.access_mode,
        source_post_status: "published",
        story_status: asset.story_status,
        locked_delivery_status: asset.locked_delivery_status,
        access_granted: true,
        decision_reason: "purchase_entitlement",
        delivery_kind: "story_cdr_ref",
        delivery_ref: buildAssetContentPath(asset.community_id, asset.asset_id),
        story_cdr_access: await buildStoryCdrAccessPackage({
          env: input.env,
          asset,
          callerWalletAddress,
          userId: input.userId,
          decisionReason: "purchase_entitlement",
        }),
      }
    }

    return {
      asset_id: asset.asset_id,
      community_id: asset.community_id,
      source_post_id: asset.source_post_id,
      access_mode: asset.access_mode,
      source_post_status: "published",
      story_status: asset.story_status,
      locked_delivery_status: asset.locked_delivery_status,
      access_granted: false,
      decision_reason: asset.locked_delivery_status === "ready" ? "purchase_required" : "delivery_pending",
      delivery_kind: null,
      delivery_ref: null,
      story_cdr_access: null,
    }
  } finally {
    db.close()
  }
}

export async function fetchCommunityAssetContent(input: {
  env: Env
  userId: string
  communityId: string
  assetId: string
  communityRepository: CommunityRepository
  userRepository: UserRepository
}): Promise<Response> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const asset = await getAssetRow(db.client, input.communityId, input.assetId)
    if (!asset) {
      throw notFoundError("Asset not found")
    }
    const post = await getPostById(db.client, asset.source_post_id)
    const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
    const isPrivilegedViewer = asset.creator_user_id === input.userId || membership.role_status === "active"
    if (!post) {
      throw notFoundError("Asset not found")
    }
    if (post.status !== "published" && !isPrivilegedViewer) {
      throw notFoundError("Asset content not found")
    }
    if (asset.access_mode === "public" || !asset.locked_delivery_storage_ref) {
      return await fetchPrimarySongAssetContent({
        env: input.env,
        communityId: input.communityId,
        storageRef: asset.primary_content_ref,
      })
    }
    return await fetchSongArtifactBytes({
      env: input.env,
      objectKey: asset.locked_delivery_storage_ref,
    })
  } finally {
    db.close()
  }
}

function resolveRegionalPrice(input: {
  listing: CommunityListing
  pricingPolicy: CommunityPricingPolicy
  buyer: Awaited<ReturnType<UserRepository["getUserById"]>>
}): { finalPriceUsd: number; pricingTier: string | null; verificationSnapshot: Record<string, unknown> | null } {
  const basePriceUsd = input.listing.price_usd
  if (!input.listing.regional_pricing_enabled || !input.pricingPolicy.regional_pricing_enabled || !input.buyer) {
    return { finalPriceUsd: basePriceUsd, pricingTier: null, verificationSnapshot: null }
  }
  const nationality = input.buyer.verification_capabilities.nationality
  if (nationality.state !== "verified" || nationality.provider !== "self") {
    return { finalPriceUsd: basePriceUsd, pricingTier: null, verificationSnapshot: null }
  }
  const countryCode = (nationality.value || "").toUpperCase()
  const assignment = input.pricingPolicy.country_assignments.find((entry) => entry.country_code === countryCode)
  const tierKey = assignment?.tier_key || input.pricingPolicy.default_tier_key || null
  if (!tierKey) {
    return { finalPriceUsd: basePriceUsd, pricingTier: null, verificationSnapshot: null }
  }
  const tier = input.pricingPolicy.tiers.find((entry) => entry.tier_key === tierKey)
  if (!tier) {
    return { finalPriceUsd: basePriceUsd, pricingTier: null, verificationSnapshot: null }
  }
  const finalPriceUsd = tier.adjustment_type === "fixed_price_usd"
    ? roundUsd(tier.adjustment_value)
    : roundUsd(basePriceUsd * tier.adjustment_value)
  return {
    finalPriceUsd,
    pricingTier: tier.tier_key,
    verificationSnapshot: {
      nationality_state: nationality.state,
      nationality_value: countryCode || null,
      provider: nationality.provider,
      pricing_tier: tier.tier_key,
      pricing_policy_version: input.pricingPolicy.pricing_policy_version,
    },
  }
}

function resolveRoutePolicy(input: {
  moneyPolicy: CommunityMoneyPolicy
  body: CommunityPurchaseQuotePreflightRequest
}): {
  eligible: boolean
  fundingMode: "direct" | "routed"
  routePolicyCompliant: boolean
  routeLiveAvailable: boolean | null
} {
  const routeRequired = input.moneyPolicy.route_required
  if (!routeRequired) {
    return {
      eligible: true,
      fundingMode: "direct",
      routePolicyCompliant: true,
      routeLiveAvailable: null,
    }
  }
  const providerAllowed = !input.moneyPolicy.approved_route_providers?.length
    || (!!input.body.route_provider && input.moneyPolicy.approved_route_providers.includes(input.body.route_provider))
  const fundingAssetAllowed = !input.moneyPolicy.accepted_funding_assets.length
    || input.moneyPolicy.accepted_funding_assets.some((asset) =>
      asset.asset_symbol === input.body.funding_asset?.asset_symbol
      && (asset.chain_namespace ?? null) === (input.body.funding_asset?.chain_namespace ?? null)
      && (asset.chain_id ?? null) === (input.body.funding_asset?.chain_id ?? null))
  const sourceChainAllowed = !input.moneyPolicy.accepted_source_chains.length
    || input.moneyPolicy.accepted_source_chains.some((chain) =>
      chain.chain_namespace === input.body.source_chain?.chain_namespace
      && (chain.chain_id ?? null) === (input.body.source_chain?.chain_id ?? null))
  const routePolicyCompliant = providerAllowed
    && fundingAssetAllowed
    && sourceChainAllowed
    && input.body.client_estimated_slippage_bps <= input.moneyPolicy.max_slippage_bps
    && input.body.client_estimated_hop_count <= input.moneyPolicy.route_hop_tolerance
  return {
    eligible: routePolicyCompliant,
    fundingMode: "routed",
    routePolicyCompliant,
    routeLiveAvailable: routePolicyCompliant,
  }
}

export async function listCommunityListings(input: {
  env: Env
  userId: string
  communityId: string
  communityRepository: CommunityRepository
}): Promise<CommunityListingListResponse> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    return {
      items: (await listListingRows(db.client, input.communityId)).map((row) => serializeListing(row)),
    }
  } finally {
    db.close()
  }
}

export async function createCommunityListing(input: {
  env: Env
  userId: string
  communityId: string
  body: CreateCommunityListingRequest
  communityRepository: CommunityRepository
  userRepository: UserRepository
}): Promise<CommunityListing> {
  if (!input.body.asset_id?.trim() && !input.body.live_room_id?.trim()) {
    throw badRequestError("asset_id or live_room_id is required")
  }
  await requireVerifiedHuman(input.userRepository, input.userId)
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    if (input.body.asset_id?.trim()) {
      const asset = await getAssetRow(db.client, input.communityId, input.body.asset_id)
      if (!asset) {
        throw notFoundError("Asset not found")
      }
      if (asset.creator_user_id !== input.userId) {
        const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
        if (membership.role_status !== "active") {
          throw notFoundError("Asset not found")
        }
      }
      if (await getListingRowByAssetId(db.client, input.communityId, input.body.asset_id)) {
        throw badRequestError("Asset already has a listing")
      }
      const pricingPolicy = await getCommunityPricingPolicy({ env: input.env, communityId: input.communityId })
      if (input.body.regional_pricing_enabled && !pricingPolicy.regional_pricing_enabled) {
        throw badRequestError("Community regional pricing is not enabled")
      }
    }
    const listingId = makeId("lst")
    const createdAt = nowIso()
    await db.client.execute({
      sql: `
        INSERT INTO listings (
          listing_id, community_id, asset_id, live_room_id, listing_mode, status, price_usd,
          regional_pricing_policy_json, created_by_user_id, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, 'fixed_price', ?5, ?6,
          ?7, ?8, ?9, ?9
        )
      `,
      args: [
        listingId,
        input.communityId,
        input.body.asset_id ?? null,
        input.body.live_room_id ?? null,
        input.body.status,
        input.body.price_usd,
        JSON.stringify({ regional_pricing_enabled: input.body.regional_pricing_enabled }),
        input.userId,
        createdAt,
      ],
    })
    const listing = await getListingRowById(db.client, input.communityId, listingId)
    if (!listing) {
      throw notFoundError("Listing not found")
    }
    return serializeListing(listing)
  } finally {
    db.close()
  }
}

export async function updateCommunityListing(input: {
  env: Env
  userId: string
  communityId: string
  listingId: string
  body: UpdateCommunityListingRequest
  communityRepository: CommunityRepository
}): Promise<CommunityListing> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const listing = await getListingRowById(db.client, input.communityId, input.listingId)
    if (!listing) {
      throw notFoundError("Listing not found")
    }
    if (listing.created_by_user_id !== input.userId) {
      const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
      if (membership.role_status !== "active") {
        throw notFoundError("Listing not found")
      }
    }
    const nextRegional = input.body.regional_pricing_enabled
      ?? parseJsonValue<{ regional_pricing_enabled?: boolean }>(listing.regional_pricing_policy_json, {}).regional_pricing_enabled
      ?? false
    if (nextRegional) {
      const pricingPolicy = await getCommunityPricingPolicy({ env: input.env, communityId: input.communityId })
      if (!pricingPolicy.regional_pricing_enabled) {
        throw badRequestError("Community regional pricing is not enabled")
      }
    }
    await db.client.execute({
      sql: `
        UPDATE listings
        SET status = ?3,
            price_usd = ?4,
            regional_pricing_policy_json = ?5,
            updated_at = ?6
        WHERE community_id = ?1
          AND listing_id = ?2
      `,
      args: [
        input.communityId,
        input.listingId,
        input.body.status ?? listing.status,
        input.body.price_usd ?? listing.price_usd,
        JSON.stringify({
          regional_pricing_enabled: nextRegional,
        }),
        nowIso(),
      ],
    })
    const updated = await getListingRowById(db.client, input.communityId, input.listingId)
    if (!updated) {
      throw notFoundError("Listing not found")
    }
    return serializeListing(updated)
  } finally {
    db.close()
  }
}

export async function getCommunityListing(input: {
  env: Env
  userId: string
  communityId: string
  listingId: string
  communityRepository: CommunityRepository
}): Promise<CommunityListing> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const listing = await getListingRowById(db.client, input.communityId, input.listingId)
    if (!listing) {
      throw notFoundError("Listing not found")
    }
    return serializeListing(listing)
  } finally {
    db.close()
  }
}

export async function preflightCommunityPurchaseQuote(input: {
  env: Env
  userId: string
  communityId: string
  body: CommunityPurchaseQuotePreflightRequest
  communityRepository: CommunityRepository
  userRepository: UserRepository
}): Promise<CommunityPurchaseQuotePreflight> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const moneyPolicy = await getCommunityMoneyPolicy({ env: input.env, communityId: input.communityId })
    const route = resolveRoutePolicy({ moneyPolicy, body: input.body })
    const quotedAt = nowIso()
    const expiresAt = new Date(Date.now() + moneyPolicy.quote_ttl_seconds * 1000).toISOString()
    return {
      community_id: input.communityId,
      eligible: route.eligible,
      funding_mode: route.fundingMode,
      policy_origin: moneyPolicy.policy_origin,
      funding_preference: moneyPolicy.funding_preference,
      funding_asset: input.body.funding_asset ?? null,
      source_chain: input.body.source_chain ?? null,
      route_provider: input.body.route_provider ?? null,
      destination_settlement_chain: moneyPolicy.destination_settlement_chain,
      destination_settlement_token: moneyPolicy.destination_settlement_token,
      treasury_denomination: moneyPolicy.treasury_denomination ?? null,
      max_slippage_bps: moneyPolicy.max_slippage_bps,
      quote_ttl_seconds: moneyPolicy.quote_ttl_seconds,
      route_required: moneyPolicy.route_required,
      route_status_policy: moneyPolicy.route_status_policy,
      route_hop_tolerance: moneyPolicy.route_hop_tolerance,
      quoted_at: quotedAt,
      expires_at: expiresAt,
    }
  } finally {
    db.close()
  }
}

export async function createCommunityPurchaseQuote(input: {
  env: Env
  userId: string
  communityId: string
  body: CommunityPurchaseQuoteRequest
  communityRepository: CommunityRepository
  userRepository: UserRepository
}): Promise<CommunityPurchaseQuote> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const listing = await getListingRowById(db.client, input.communityId, input.body.listing_id)
    if (!listing || listing.status !== "active") {
      throw notFoundError("Listing not found")
    }
    const moneyPolicy = await getCommunityMoneyPolicy({ env: input.env, communityId: input.communityId })
    const route = resolveRoutePolicy({ moneyPolicy, body: input.body })
    if (!route.eligible) {
      throw eligibilityFailed("Funding lane does not satisfy community money policy")
    }
    const pricingPolicy = await getCommunityPricingPolicy({ env: input.env, communityId: input.communityId })
    const buyer = await input.userRepository.getUserById(input.userId)
    const resolvedPrice = resolveRegionalPrice({
      listing: serializeListing(listing),
      pricingPolicy,
      buyer,
    })
    const quoteId = makeId("qte")
    const quotedAt = nowIso()
    const expiresAt = new Date(Date.now() + moneyPolicy.quote_ttl_seconds * 1000).toISOString()
    const verificationSnapshotRef = resolvedPrice.verificationSnapshot ? makeId("qvs") : null
    await db.client.execute({
      sql: `
        INSERT INTO purchase_quotes (
          quote_id, community_id, listing_id, buyer_user_id, asset_id, live_room_id, base_price_usd,
          pricing_tier, final_price_usd, funding_mode, funding_asset_json, source_chain_json,
          route_provider, route_policy_compliant, route_live_available, policy_origin,
          destination_settlement_chain_json, destination_settlement_token, treasury_denomination,
          quote_ttl_seconds, route_required, route_status_policy, route_hop_tolerance,
          verification_snapshot_ref, pricing_policy_version, status, quoted_at, expires_at,
          consumed_at, failed_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, NULL, ?6,
          ?7, ?8, ?9, ?10, ?11,
          ?12, ?13, ?14, ?15,
          ?16, ?17, ?18,
          ?19, ?20, ?21, ?22,
          ?23, ?24, 'active', ?25, ?26,
          NULL, NULL, ?25, ?25
        )
      `,
      args: [
        quoteId,
        input.communityId,
        listing.listing_id,
        input.userId,
        listing.asset_id,
        listing.price_usd,
        resolvedPrice.pricingTier,
        resolvedPrice.finalPriceUsd,
        route.fundingMode,
        input.body.funding_asset ? JSON.stringify(input.body.funding_asset) : null,
        input.body.source_chain ? JSON.stringify(input.body.source_chain) : null,
        input.body.route_provider ?? null,
        boolToSqlite(route.routePolicyCompliant),
        route.routeLiveAvailable == null ? null : boolToSqlite(route.routeLiveAvailable),
        moneyPolicy.policy_origin,
        JSON.stringify(moneyPolicy.destination_settlement_chain),
        moneyPolicy.destination_settlement_token,
        moneyPolicy.treasury_denomination ?? null,
        moneyPolicy.quote_ttl_seconds,
        boolToSqlite(moneyPolicy.route_required),
        moneyPolicy.route_status_policy,
        moneyPolicy.route_hop_tolerance,
        verificationSnapshotRef,
        resolvedPrice.pricingTier ? pricingPolicy.pricing_policy_version : null,
        quotedAt,
        expiresAt,
      ],
    })
    if (verificationSnapshotRef) {
      await db.client.execute({
        sql: `
          INSERT INTO purchase_quote_verification_snapshots (
            verification_snapshot_ref, community_id, quote_id, buyer_user_id, provider, nationality_state,
            nationality_value, pricing_tier, pricing_policy_version, snapshot_json, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6,
            ?7, ?8, ?9, ?10, ?11, ?11
          )
        `,
        args: [
          verificationSnapshotRef,
          input.communityId,
          quoteId,
          input.userId,
          String(resolvedPrice.verificationSnapshot?.provider ?? "self"),
          String(resolvedPrice.verificationSnapshot?.nationality_state ?? "verified"),
          String(resolvedPrice.verificationSnapshot?.nationality_value ?? ""),
          resolvedPrice.pricingTier,
          pricingPolicy.pricing_policy_version,
          JSON.stringify(resolvedPrice.verificationSnapshot),
          quotedAt,
        ],
      })
    }
    const quote = await getPurchaseQuoteRow(db.client, input.communityId, quoteId)
    if (!quote) {
      throw notFoundError("Quote not found")
    }
    return serializeQuote(quote)
  } finally {
    db.close()
  }
}

export async function settleCommunityPurchase(input: {
  env: Env
  userId: string
  communityId: string
  body: CommunityPurchaseSettlementRequest
  communityRepository: CommunityRepository
}): Promise<CommunityPurchaseSettlement> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const quote = await getPurchaseQuoteRow(db.client, input.communityId, input.body.quote_id)
    if (!quote || quote.buyer_user_id !== input.userId) {
      throw notFoundError("Purchase quote not found")
    }
    if (quote.status !== "active") {
      throw badRequestError("Purchase quote is not active")
    }
    if (new Date(quote.expires_at).getTime() <= Date.now()) {
      await db.client.execute({
        sql: `
          UPDATE purchase_quotes
          SET status = 'expired',
              updated_at = ?3
          WHERE community_id = ?1
            AND quote_id = ?2
        `,
        args: [input.communityId, input.body.quote_id, nowIso()],
      })
      throw badRequestError("Purchase quote has expired")
    }
    const purchaseId = makeId("pur")
    const createdAt = nowIso()
    const settlementChain = parseJsonValue<CommunityPurchaseSettlement["settlement_chain"]>(
      quote.destination_settlement_chain_json,
      { chain_namespace: "eip155", chain_id: 1315, display_name: "Story Aeneid" },
    )
    await db.client.execute({
      sql: `
        INSERT INTO purchases (
          purchase_id, community_id, listing_id, asset_id, live_room_id, buyer_user_id,
          settlement_wallet_attachment_id, purchase_price_usd, pricing_tier, settlement_chain,
          settlement_token, settlement_tx_ref, donation_partner_id, donation_share_pct,
          donation_amount_usd, donation_settlement_ref, created_at
        ) VALUES (
          ?1, ?2, ?3, ?4, NULL, ?5,
          ?6, ?7, ?8, ?9,
          ?10, ?11, NULL, NULL,
          NULL, NULL, ?12
        )
      `,
      args: [
        purchaseId,
        input.communityId,
        quote.listing_id,
        quote.asset_id,
        input.userId,
        input.body.settlement_wallet_attachment_id,
        quote.final_price_usd,
        quote.pricing_tier,
        JSON.stringify(settlementChain),
        quote.destination_settlement_token,
        input.body.settlement_tx_ref,
        createdAt,
      ],
    })
    let entitlement = quote.asset_id
      ? await getActiveEntitlementForBuyer(db.client, input.communityId, input.userId, quote.asset_id)
      : null
    if (!entitlement) {
      entitlement = {
        purchase_entitlement_id: makeId("ent"),
        purchase_id: purchaseId,
        community_id: input.communityId,
        buyer_user_id: input.userId,
        entitlement_kind: "asset_access",
        target_ref: quote.asset_id || quote.listing_id,
        status: "active",
        granted_at: createdAt,
        revoked_at: null,
        created_at: createdAt,
        updated_at: createdAt,
      }
      await db.client.execute({
        sql: `
          INSERT INTO purchase_entitlements (
            purchase_entitlement_id, purchase_id, community_id, buyer_user_id, entitlement_kind,
            target_ref, status, granted_at, revoked_at, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5,
            ?6, ?7, ?8, NULL, ?8, ?8
          )
        `,
        args: [
          entitlement.purchase_entitlement_id,
          entitlement.purchase_id,
          entitlement.community_id,
          entitlement.buyer_user_id,
          entitlement.entitlement_kind,
          entitlement.target_ref,
          entitlement.status,
          entitlement.granted_at,
        ],
      })
    }
    await db.client.execute({
      sql: `
        UPDATE purchase_quotes
        SET status = 'consumed',
            consumed_at = ?3,
            updated_at = ?3
        WHERE community_id = ?1
          AND quote_id = ?2
      `,
      args: [input.communityId, input.body.quote_id, createdAt],
    })
    const purchase = await getPurchaseRow(db.client, input.communityId, purchaseId)
    if (!purchase) {
      throw notFoundError("Purchase not found")
    }
    return serializeSettlement(purchase, entitlement, quote)
  } finally {
    db.close()
  }
}

export async function failCommunityPurchase(input: {
  env: Env
  userId: string
  communityId: string
  body: CommunityPurchaseSettlementFailureRequest
  communityRepository: CommunityRepository
}): Promise<CommunityPurchaseSettlementFailure> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const quote = await getPurchaseQuoteRow(db.client, input.communityId, input.body.quote_id)
    if (!quote || quote.buyer_user_id !== input.userId) {
      throw notFoundError("Purchase quote not found")
    }
    const now = nowIso()
    const expired = new Date(quote.expires_at).getTime() <= Date.now()
    const nextStatus = expired ? "expired" : "failed"
    await db.client.execute({
      sql: `
        UPDATE purchase_quotes
        SET status = ?3,
            failed_at = CASE WHEN ?3 = 'failed' THEN ?4 ELSE failed_at END,
            updated_at = ?4
        WHERE community_id = ?1
          AND quote_id = ?2
      `,
      args: [input.communityId, input.body.quote_id, nextStatus, now],
    })
    return {
      quote_id: quote.quote_id,
      community_id: quote.community_id,
      status: nextStatus,
      failed_at: nextStatus === "failed" ? now : null,
      expires_at: quote.expires_at,
    }
  } finally {
    db.close()
  }
}

export async function listCommunityPurchases(input: {
  env: Env
  userId: string
  communityId: string
  communityRepository: CommunityRepository
}): Promise<CommunityPurchaseListResponse> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const purchases = await listPurchaseRows(db.client, input.communityId, input.userId)
    const items: CommunityPurchase[] = []
    for (const purchase of purchases) {
      const entitlement = await getEntitlementRowByPurchase(db.client, purchase.purchase_id)
      if (entitlement) {
        items.push(serializePurchase(purchase, entitlement))
      }
    }
    return { items }
  } finally {
    db.close()
  }
}

export async function getCommunityPurchase(input: {
  env: Env
  userId: string
  communityId: string
  purchaseId: string
  communityRepository: CommunityRepository
}): Promise<CommunityPurchase> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const purchase = await getPurchaseRow(db.client, input.communityId, input.purchaseId)
    if (!purchase || purchase.buyer_user_id !== input.userId) {
      throw notFoundError("Purchase not found")
    }
    const entitlement = await getEntitlementRowByPurchase(db.client, purchase.purchase_id)
    if (!entitlement) {
      throw notFoundError("Purchase not found")
    }
    return serializePurchase(purchase, entitlement)
  } finally {
    db.close()
  }
}
