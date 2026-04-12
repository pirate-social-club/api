#!/usr/bin/env bun

import { createHash, randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { createClient } from "@libsql/client"
import { createPublicClient, createWalletClient, encodeFunctionData, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import app from "../src/index"
import { CDRClient, initWasm, type StorageProvider } from "../src/lib/posts/story-cdr-sdk-client"
import { getStoryAeneidDeliveryDefaults } from "../src/lib/posts/story-delivery-config"
import type { Env } from "../src/types"
import { buildStoryPurchaseRef } from "../src/lib/communities/story-settlement-runtime"
import { createRouteTestContext, json, mintUpstreamJwt, resetRuntimeCaches } from "../tests/helpers"
import { readDevVarsFromCwd } from "./_lib/dev-vars"
import { assertIpfsUnixFsCid } from "./_lib/ipfs-cid"
import { cdrAbi, contractAddresses } from "../../../../../cdr-sdk/packages/contracts/dist/index.js"

type UploadedSongArtifact = {
  song_artifact_upload_id: string
  storage_ref: string
  mime_type: string
  size_bytes: number | null
  content_hash: string | null
  storage_provider: "filebase" | "local_stub" | null
  storage_bucket: string | null
  storage_object_key: string | null
  storage_endpoint: string | null
  gateway_url: string | null
}

type BundleReadResponse = {
  song_artifact_bundle_id: string
  preview_status: string
  preview_error?: string | null
  preview_audio?: {
    storage_ref: string
    mime_type: string
    size_bytes?: number | null
    content_hash?: string | null
    clip_start_ms?: number | null
    clip_duration_ms?: number | null
  } | null
  translation_status: string
  alignment_status: string
  moderation_status: string
  translated_lyrics?: unknown
  timed_lyrics?: unknown
  moderation_result?: unknown
}

type AssetReadResponse = {
  asset_id: string
  source_post_id: string
  access_mode: string
  primary_content_ref: string | null
  preview_audio?: {
    storage_ref: string
    mime_type: string
  } | null
  cover_art?: {
    storage_ref: string
    mime_type: string
  } | null
  canvas_video?: {
    storage_ref: string
    mime_type: string
  } | null
  locked_delivery_status: string
  locked_delivery_ref: string | null
  locked_delivery_error: string | null
  story_status: string
  story_error: string | null
  story_publish_tx_ref: string | null
  story_asset_version_id: string | null
  story_cdr_vault_uuid: number | null
  story_cdr_encrypted_cid: string | null
  story_entitlement_token_id: string | null
  story_read_condition: string | null
}

type CdrManifestResponse = {
  asset_id: string
  community_id: string
  access_mode: "locked"
  decision_reason: "creator" | "moderator" | "purchase_entitlement"
  delivery_ref: string
  network: "testnet"
  rpc_url: string
  dkg_source: "evm-events" | "cosmos-abci"
  comet_rpc_url: string | null
  gateway_base_url: string
  encrypted_cid: string
  encrypted_fetch_url: string | null
  vault_uuid: number
  wallet_attachment_id: string
  caller_address: string
  signer_family: string | null
  signer_address: string | null
  verifier_contract: string | null
  namespace: string | null
  access_ref: string | null
  scope: string | null
  expiry: string | null
  digest: string | null
  condition_data: string
  access_aux_data: string
  signature: string | null
  proof: unknown
}

type ParsedArgs = {
  keepFiles: boolean
  stopAfterStoryPublish: boolean
  disableDirectPublish: boolean
  disableSdkWriter: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  return {
    keepFiles: argv.includes("--keep-files"),
    stopAfterStoryPublish: argv.includes("--stop-after-story-publish"),
    disableDirectPublish: argv.includes("--disable-direct-publish"),
    disableSdkWriter: argv.includes("--disable-sdk-writer"),
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

async function downloadFileWithRetry(input: {
  client: CDRClient
  uuid: number
  accessAuxData: `0x${string}`
  storageProvider: StorageProvider
  skipCidVerification: boolean
}): Promise<{
  content: Uint8Array
  cid: string
  txHash: `0x${string}`
}> {
  let lastError: Error | null = null
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await input.client.consumer.downloadFile({
        uuid: input.uuid,
        accessAuxData: input.accessAuxData,
        storageProvider: input.storageProvider,
        skipCidVerification: input.skipCidVerification,
      })
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error))
      lastError = normalized
      if (!normalized.message.includes("Vault has no data to read") || attempt === 5) {
        throw normalized
      }
      console.error(`[song-cdr-local-e2e] retrying vault read after transient empty-data response (${attempt + 1}/6)`)
      await Bun.sleep(5000)
    }
  }
  throw lastError ?? new Error("cdr_download_failed")
}

function buildWavBytes(durationMs: number, sampleRate = 44_100): Uint8Array {
  const channelCount = 2
  const bytesPerSample = 2
  const sampleCount = Math.max(1, Math.round((durationMs / 1000) * sampleRate))
  const dataSize = sampleCount * channelCount * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index))
    }
  }

  writeAscii(0, "RIFF")
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(8, "WAVE")
  writeAscii(12, "fmt ")
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true)
  view.setUint16(32, channelCount * bytesPerSample, true)
  view.setUint16(34, bytesPerSample * 8, true)
  writeAscii(36, "data")
  view.setUint32(40, dataSize, true)

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const seconds = sampleIndex / sampleRate
    const sampleValue = Math.round(Math.sin(seconds * 2 * Math.PI * 440) * 0x1fff)
    const offset = 44 + (sampleIndex * channelCount * bytesPerSample)
    view.setInt16(offset, sampleValue, true)
    view.setInt16(offset + 2, sampleValue, true)
  }

  return new Uint8Array(buffer)
}

function randomPrivateKey(): `0x${string}` {
  return `0x${randomBytes(32).toString("hex")}` as `0x${string}`
}

async function requestJson(
  url: string,
  body: unknown,
  env: Env,
  token?: string,
  method = "POST",
): Promise<Response> {
  return await app.request(
    url,
    {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  )
}

async function requestBytes(
  url: string,
  body: Uint8Array,
  env: Env,
  token?: string,
  method = "PUT",
  contentType = "application/octet-stream",
): Promise<Response> {
  return await app.request(
    url,
    {
      method,
      headers: {
        "content-type": contentType,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body as unknown as BodyInit,
    },
    env,
  )
}

async function exchangeJwt(env: Env, sub: string): Promise<{ accessToken: string; userId: string }> {
  const jwt = await mintUpstreamJwt(env, { sub })
  const response = await requestJson("http://pirate.test/auth/session/exchange", {
    proof: {
      type: "jwt_based_auth",
      jwt,
    },
  }, env)
  if (response.status !== 200) {
    throw new Error(`jwt_exchange_failed:${response.status}:${await response.text()}`)
  }
  const body = await json(response) as { access_token: string; user: { user_id: string } }
  return { accessToken: body.access_token, userId: body.user.user_id }
}

async function prepareVerifiedNamespace(
  env: Env,
  accessToken: string,
  rootLabel: string,
): Promise<string> {
  const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
    provider: "self",
  }, env, accessToken)
  const verificationBody = await json(verificationSession) as { verification_session_id: string }
  await requestJson(
    `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/complete`,
    {},
    env,
    accessToken,
  )

  const namespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
    family: "hns",
    root_label: rootLabel,
  }, env, accessToken)
  const namespaceBody = await json(namespaceSession) as { namespace_verification_session_id: string }
  const completed = await requestJson(
    `http://pirate.test/namespace-verification-sessions/${namespaceBody.namespace_verification_session_id}/complete`,
    {},
    env,
    accessToken,
  )
  const completedBody = await json(completed) as { namespace_verification_id: string }
  return completedBody.namespace_verification_id
}

async function setPrimaryWalletAttachment(
  env: Env,
  userId: string,
  walletAddress: string,
): Promise<string> {
  const client = createClient({
    url: String(env.CONTROL_PLANE_DATABASE_URL),
  })

  try {
    const walletAttachmentId = `wal_${userId}`
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        INSERT INTO wallet_attachments (
          wallet_attachment_id, user_id, chain_namespace, wallet_address_normalized, wallet_address_display,
          source_provider, source_subject, attachment_kind, is_primary, status, attached_at, detached_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, 'eip155:1315', ?3, ?3,
          'live-smoke', ?2, 'external', 1, 'active', ?4, NULL, ?4, ?4
        )
        ON CONFLICT(wallet_attachment_id) DO UPDATE SET
          wallet_address_normalized = excluded.wallet_address_normalized,
          wallet_address_display = excluded.wallet_address_display,
          is_primary = 1,
          status = 'active',
          detached_at = NULL,
          updated_at = excluded.updated_at
      `,
      args: [walletAttachmentId, userId, walletAddress.toLowerCase(), now],
    })

    await client.execute({
      sql: `
        UPDATE users
        SET primary_wallet_attachment_id = ?2,
            updated_at = ?3
        WHERE user_id = ?1
      `,
      args: [userId, walletAttachmentId, now],
    })
    return walletAttachmentId
  } finally {
    client.close()
  }
}

async function createCompletedSongArtifactUpload(input: {
  env: Env
  accessToken: string
  communityId: string
  artifactKind: "primary_audio" | "cover_art" | "preview_audio" | "canvas_video"
  mimeType: string
  filename: string
  bytes: Uint8Array
}): Promise<UploadedSongArtifact> {
  const createResponse = await requestJson(
    `http://pirate.test/communities/${input.communityId}/song-artifact-uploads`,
    {
      artifact_kind: input.artifactKind,
      mime_type: input.mimeType,
      filename: input.filename,
      size_bytes: input.bytes.byteLength,
      content_hash: `sha256:${sha256Hex(input.bytes)}`,
    },
    input.env,
    input.accessToken,
  )
  if (createResponse.status !== 201) {
    throw new Error(`song_artifact_upload_create_failed:${createResponse.status}:${await createResponse.text()}`)
  }
  const created = await json(createResponse) as UploadedSongArtifact

  const uploadResponse = await requestBytes(
    `http://pirate.test/communities/${input.communityId}/song-artifact-uploads/${created.song_artifact_upload_id}/content`,
    input.bytes,
    input.env,
    input.accessToken,
    "PUT",
    input.mimeType,
  )
  if (uploadResponse.status !== 200) {
    throw new Error(`song_artifact_upload_content_failed:${uploadResponse.status}:${await uploadResponse.text()}`)
  }
  return await json(uploadResponse) as UploadedSongArtifact
}

async function drainJob(env: Env, path: string, token: string): Promise<void> {
  const response = await app.request(
    `http://pirate.test${path}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
    env,
  )
  if (response.status !== 200) {
    throw new Error(`job_drain_failed:${path}:${response.status}:${await response.text()}`)
  }
}

async function getBundle(
  env: Env,
  communityId: string,
  bundleId: string,
  token: string,
): Promise<BundleReadResponse> {
  const response = await app.request(
    `http://pirate.test/communities/${communityId}/song-artifacts/${bundleId}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
    env,
  )
  if (response.status !== 200) {
    throw new Error(`bundle_read_failed:${response.status}:${await response.text()}`)
  }
  return await json(response) as BundleReadResponse
}

async function getAsset(
  env: Env,
  communityId: string,
  assetId: string,
  token: string,
): Promise<AssetReadResponse> {
  const response = await app.request(
    `http://pirate.test/communities/${communityId}/assets/${assetId}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
      },
    },
    env,
  )
  if (response.status !== 200) {
    throw new Error(`asset_read_failed:${response.status}:${await response.text()}`)
  }
  return await json(response) as AssetReadResponse
}

async function waitForPreviewReady(input: {
  env: Env
  communityId: string
  bundleId: string
  accessToken: string
  internalJobRunnerToken: string
}): Promise<BundleReadResponse> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const bundle = await getBundle(input.env, input.communityId, input.bundleId, input.accessToken)
    if (bundle.preview_status === "completed" && bundle.preview_audio) {
      return bundle
    }
    if (bundle.preview_status === "failed") {
      throw new Error(`preview_failed:${bundle.preview_error || "unknown"}`)
    }
    await drainJob(input.env, "/jobs/internal/song-previews/drain?limit=10", input.internalJobRunnerToken)
    await Bun.sleep(800)
  }
  throw new Error("preview_timeout")
}

async function waitForBundleEnrichment(input: {
  env: Env
  communityId: string
  bundleId: string
  accessToken: string
  internalJobRunnerToken: string
}): Promise<BundleReadResponse> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const bundle = await getBundle(input.env, input.communityId, input.bundleId, input.accessToken)
    const states = [bundle.translation_status, bundle.alignment_status, bundle.moderation_status]
    if (states.every((value) => value === "completed")) {
      return bundle
    }
    if (states.some((value) => value === "failed")) {
      throw new Error(`bundle_enrichment_failed:${JSON.stringify(bundle)}`)
    }
    await drainJob(input.env, "/jobs/internal/song-enrichments/drain?limit=10", input.internalJobRunnerToken)
    await Bun.sleep(1500)
  }
  throw new Error("bundle_enrichment_timeout")
}

async function waitForLockedDeliveryReady(input: {
  env: Env
  communityId: string
  assetId: string
  accessToken: string
  internalJobRunnerToken: string
}): Promise<AssetReadResponse> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const asset = await getAsset(input.env, input.communityId, input.assetId, input.accessToken)
    if (asset.locked_delivery_status === "ready") {
      return asset
    }
    if (asset.locked_delivery_status === "failed") {
      throw new Error(`locked_delivery_failed:${asset.locked_delivery_error || "unknown"}`)
    }
    await drainJob(input.env, "/jobs/internal/song-locked-deliveries/drain?limit=10", input.internalJobRunnerToken)
    await Bun.sleep(1500)
  }
  throw new Error("locked_delivery_timeout")
}

async function waitForStoryPublish(input: {
  env: Env
  communityId: string
  assetId: string
  accessToken: string
  internalJobRunnerToken: string
}): Promise<AssetReadResponse> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const asset = await getAsset(input.env, input.communityId, input.assetId, input.accessToken)
    if (asset.story_status === "published") {
      return asset
    }
    if (asset.story_status === "failed") {
      throw new Error(`story_publish_failed:${asset.story_error || "unknown"}`)
    }
    await drainJob(input.env, "/jobs/internal/song-assets/drain?limit=10", input.internalJobRunnerToken)
    await Bun.sleep(1500)
  }
  throw new Error("story_publish_timeout")
}

async function ensureFfmpegAsset(input: {
  args: string[]
  outputPath: string
  label: string
}): Promise<Uint8Array> {
  const proc = Bun.spawn({
    cmd: ["ffmpeg", "-y", ...input.args, input.outputPath],
    stdout: "ignore",
    stderr: "pipe",
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`ffmpeg_${input.label}_failed:${stderr.slice(0, 500)}`)
  }
  return new Uint8Array(await readFile(input.outputPath))
}

class GatewayStorageProvider implements StorageProvider {
  lastDownloadedCid: string | null = null

  lastDownloadedBytes: Uint8Array | null = null

  constructor(
    private readonly gatewayBaseUrl: string,
    private readonly directFetchUrl: string | null = null,
  ) {}

  async upload(): Promise<string> {
    throw new Error("gateway_storage_provider_upload_not_supported")
  }

  async download(cid: string): Promise<Uint8Array> {
    const normalizedCid = String(cid || "").trim().replace(/^ipfs:\/\//, "")
    const directUrl = String(this.directFetchUrl || "").trim()
    if (directUrl) {
      const response = await fetch(directUrl)
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer())
        this.lastDownloadedCid = normalizedCid
        this.lastDownloadedBytes = bytes
        return bytes
      }
    }
    const url = `${this.gatewayBaseUrl.replace(/\/+$/, "")}/ipfs/${normalizedCid}`
    let lastError = "gateway_download_failed:unknown"
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const response = await fetch(url)
      if (response.ok) {
        const bytes = new Uint8Array(await response.arrayBuffer())
        this.lastDownloadedCid = normalizedCid
        this.lastDownloadedBytes = bytes
        return bytes
      }
      const raw = await response.text()
      lastError = `gateway_download_failed:${response.status}:${raw}`
      if (response.status !== 404 || attempt === 23) {
        throw new Error(lastError)
      }
      await Bun.sleep(5000)
    }
    throw new Error(lastError)
  }
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
    const target =
      input.params[0] && typeof input.params[0] === "object" && input.params[0] !== null && "to" in input.params[0]
        ? String((input.params[0] as { to?: unknown }).to || "")
        : ""
    throw new Error(`rpc_error:${input.method}${target ? `:${target}` : ""}:${payload.error?.message || response.status}`)
  }
  return payload.result
}

async function waitForReceipt(rpcUrl: string, txHash: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const receipt = await rpcRequest({
      rpcUrl,
      method: "eth_getTransactionReceipt",
      params: [txHash],
    }) as { status?: string } | null
    if (receipt?.status) {
      if (receipt.status !== "0x1") {
        throw new Error(`tx_reverted:${txHash}`)
      }
      return
    }
    await Bun.sleep(1000)
  }
  throw new Error(`tx_receipt_timeout:${txHash}`)
}

async function configureEntitlementClassIfPossible(input: {
  env: Env
  asset: AssetReadResponse
  rpcUrl: string
}): Promise<string | null> {
  const ownerPrivateKey = String(input.env.STORY_CONTRACT_OWNER_PRIVATE_KEY || "").trim()
  if (!/^0x[a-fA-F0-9]{64}$/.test(ownerPrivateKey)) {
    return null
  }

  const assetVersionId = String(input.asset.story_asset_version_id || "").trim()
  const entitlementTokenId = BigInt(String(input.asset.story_entitlement_token_id || "0"))
  const cdrVaultUuid = Number(input.asset.story_cdr_vault_uuid || 0)
  if (!/^0x[a-fA-F0-9]{64}$/.test(assetVersionId) || entitlementTokenId <= 0n || !Number.isInteger(cdrVaultUuid) || cdrVaultUuid <= 0) {
    throw new Error("entitlement_class_inputs_missing")
  }

  const purchaseEntitlementToken = String(
    input.env.STORY_ENTITLEMENT_TOKEN_ADDRESS
    || "0x0d3eF43a98077c9a71853309EE4C6665C20C1Fa6",
  ).trim()
  if (!/^0x[a-fA-F0-9]{40}$/.test(purchaseEntitlementToken)) {
    throw new Error("story_entitlement_token_address_missing")
  }

  const account = privateKeyToAccount(ownerPrivateKey as `0x${string}`)
  const nonceHex = await rpcRequest({
    rpcUrl: input.rpcUrl,
    method: "eth_getTransactionCount",
    params: [account.address, "pending"],
  }) as string
  const nonce = Number(BigInt(nonceHex))
  const serializedTx = await account.signTransaction({
    type: "eip1559",
    chainId: 1315,
    nonce,
    to: purchaseEntitlementToken as `0x${string}`,
    value: 0n,
    data: encodeFunctionData({
      abi: [{
        type: "function",
        name: "configureEntitlementClass",
        stateMutability: "nonpayable",
        inputs: [
          { name: "tokenId", type: "uint256" },
          { name: "assetVersionId", type: "bytes32" },
          { name: "cdrVaultUuid", type: "uint32" },
          { name: "active", type: "bool" },
        ],
        outputs: [],
      }],
      functionName: "configureEntitlementClass",
      args: [entitlementTokenId, assetVersionId as `0x${string}`, cdrVaultUuid, true],
    }),
    gas: 180000n,
    maxFeePerGas: 1000000000n,
    maxPriorityFeePerGas: 100000000n,
  })
  const txHash = String(await rpcRequest({
    rpcUrl: input.rpcUrl,
    method: "eth_sendRawTransaction",
    params: [serializedTx],
  }) || "").trim()
  await waitForReceipt(input.rpcUrl, txHash)
  return txHash
}

async function grantStoryPublishOperatorIfPossible(input: {
  env: Env
  rpcUrl: string
}): Promise<string | null> {
  const ownerPrivateKey = String(input.env.STORY_CONTRACT_OWNER_PRIVATE_KEY || "").trim()
  const publishPrivateKey = String(input.env.STORY_PUBLISH_OPERATOR_PRIVATE_KEY || "").trim()
  if (!/^0x[a-fA-F0-9]{64}$/.test(ownerPrivateKey) || !/^0x[a-fA-F0-9]{64}$/.test(publishPrivateKey)) {
    return null
  }

  const defaults = getStoryAeneidDeliveryDefaults()
  const coordinatorAddress = String(
    input.env.STORY_ASSET_PUBLISH_COORDINATOR_ADDRESS || defaults.assetPublishCoordinatorV1 || "",
  ).trim()
  if (!/^0x[a-fA-F0-9]{40}$/.test(coordinatorAddress)) {
    throw new Error("story_asset_publish_coordinator_address_missing")
  }

  const publishOperator = privateKeyToAccount(publishPrivateKey as `0x${string}`).address
  const alreadyGranted = String(await rpcRequest({
    rpcUrl: input.rpcUrl,
    method: "eth_call",
    params: [{
      to: coordinatorAddress,
      data: encodeFunctionData({
        abi: [{
          type: "function",
          name: "isPublishOperator",
          stateMutability: "view",
          inputs: [{ name: "operator", type: "address" }],
          outputs: [{ name: "", type: "bool" }],
        }],
        functionName: "isPublishOperator",
        args: [publishOperator],
      }),
    }, "latest"],
  }) || "").trim()
  if (alreadyGranted === "0x0000000000000000000000000000000000000000000000000000000000000001") {
    return null
  }

  const account = privateKeyToAccount(ownerPrivateKey as `0x${string}`)
  const nonceHex = await rpcRequest({
    rpcUrl: input.rpcUrl,
    method: "eth_getTransactionCount",
    params: [account.address, "pending"],
  }) as string
  const nonce = Number(BigInt(nonceHex))
  const serializedTx = await account.signTransaction({
    type: "eip1559",
    chainId: 1315,
    nonce,
    to: coordinatorAddress as `0x${string}`,
    value: 0n,
    data: encodeFunctionData({
      abi: [{
        type: "function",
        name: "setPublishOperator",
        stateMutability: "nonpayable",
        inputs: [
          { name: "operator", type: "address" },
          { name: "active", type: "bool" },
        ],
        outputs: [],
      }],
      functionName: "setPublishOperator",
      args: [publishOperator, true],
    }),
    gas: 120000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 100_000_000n,
  })
  const txHash = String(await rpcRequest({
    rpcUrl: input.rpcUrl,
    method: "eth_sendRawTransaction",
    params: [serializedTx],
  }) || "").trim()
  await waitForReceipt(input.rpcUrl, txHash)
  return txHash
}

async function fundBuyerWalletIfNeeded(input: {
  env: Env
  buyerAddress: `0x${string}`
  rpcUrl: string
}): Promise<string | null> {
  const publicClient = createPublicClient({
    transport: http(input.rpcUrl),
  })
  const readFee = await publicClient.readContract({
    address: contractAddresses.testnet.cdr,
    abi: cdrAbi,
    functionName: "readFee",
  })
  const requiredBalance = BigInt(readFee) + 5_000_000_000_000_000n
  const buyerBalance = await rpcRequest({
    rpcUrl: input.rpcUrl,
    method: "eth_getBalance",
    params: [input.buyerAddress, "latest"],
  }) as string
  if (BigInt(buyerBalance) >= requiredBalance) {
    return null
  }

  const ownerPrivateKey = String(input.env.STORY_CONTRACT_OWNER_PRIVATE_KEY || "").trim()
  const writerPrivateKey = String(input.env.STORY_CDR_WRITER_PRIVATE_KEY || "").trim()
  const candidateKeys = [ownerPrivateKey, writerPrivateKey].filter((value) => /^0x[a-fA-F0-9]{64}$/.test(value))
  if (candidateKeys.length === 0) {
    throw new Error("buyer_funding_private_key_missing")
  }
  let account: ReturnType<typeof privateKeyToAccount> | null = null
  for (const privateKey of candidateKeys) {
    const candidate = privateKeyToAccount(privateKey as `0x${string}`)
    const balanceHex = await rpcRequest({
      rpcUrl: input.rpcUrl,
      method: "eth_getBalance",
      params: [candidate.address, "latest"],
    }) as string
    if (BigInt(balanceHex) >= requiredBalance) {
      account = candidate
      break
    }
  }
  if (!account) {
    throw new Error("buyer_funding_source_insufficient")
  }

  const walletClient = createWalletClient({
    account,
    transport: http(input.rpcUrl),
  })
  const topUpAmount = requiredBalance - BigInt(buyerBalance) + 1_000_000_000_000_000n
  const txHash = await walletClient.sendTransaction({
    account,
    chain: null,
    to: input.buyerAddress,
    value: topUpAmount,
  })
  await waitForReceipt(input.rpcUrl, txHash)
  return txHash
}

async function fundCdrWriterIfNeeded(input: {
  env: Env
  rpcUrl: string
}): Promise<string | null> {
  const targetBalance = 80_000_000_000_000_000n
  const writerPrivateKey = String(input.env.STORY_CDR_WRITER_PRIVATE_KEY || "").trim()
  if (!/^0x[a-fA-F0-9]{64}$/.test(writerPrivateKey)) {
    return null
  }
  const writerAccount = privateKeyToAccount(writerPrivateKey as `0x${string}`)
  const writerBalance = await rpcRequest({
    rpcUrl: input.rpcUrl,
    method: "eth_getBalance",
    params: [writerAccount.address, "latest"],
  }) as string
  const writerBalanceWei = BigInt(writerBalance)
  if (writerBalanceWei >= targetBalance) {
    return null
  }

  const ownerPrivateKey = String(input.env.STORY_CONTRACT_OWNER_PRIVATE_KEY || "").trim()
  if (!/^0x[a-fA-F0-9]{64}$/.test(ownerPrivateKey)) {
    throw new Error("story_contract_owner_private_key_missing_for_writer_funding")
  }

  const ownerAccount = privateKeyToAccount(ownerPrivateKey as `0x${string}`)
  const walletClient = createWalletClient({
    account: ownerAccount,
    transport: http(input.rpcUrl),
  })
  const topUpAmount = targetBalance - writerBalanceWei + 5_000_000_000_000_000n
  const txHash = await walletClient.sendTransaction({
    account: ownerAccount,
    chain: null,
    to: writerAccount.address,
    value: topUpAmount,
  })
  await waitForReceipt(input.rpcUrl, txHash)
  return txHash
}

async function requestCdrReadViaRawTx(input: {
  rpcUrl: string
  buyerPrivateKey: `0x${string}`
  network: "testnet"
  vaultUuid: number
  accessAuxData: `0x${string}`
  requesterPubKey: `0x${string}`
}): Promise<`0x${string}`> {
  const account = privateKeyToAccount(input.buyerPrivateKey)
  const publicClient = createPublicClient({
    transport: http(input.rpcUrl),
  })
  const readFee = await publicClient.readContract({
    address: contractAddresses[input.network].cdr,
    abi: cdrAbi,
    functionName: "readFee",
  })
  const nonceHex = await publicClient.request({
    method: "eth_getTransactionCount",
    params: [account.address, "pending"],
  })
  const nonce = Number(BigInt(String(nonceHex)))
  const serializedTx = await account.signTransaction({
    type: "eip1559",
    chainId: 1315,
    nonce,
    to: contractAddresses[input.network].cdr,
    value: readFee,
    data: encodeFunctionData({
      abi: cdrAbi,
      functionName: "read",
      args: [input.vaultUuid, input.accessAuxData, input.requesterPubKey],
    }),
    gas: 300000n,
    maxFeePerGas: 1000000000n,
    maxPriorityFeePerGas: 100000000n,
  })
  const txHash = await publicClient.request({
    method: "eth_sendRawTransaction",
    params: [serializedTx],
  }) as `0x${string}`
  await waitForReceipt(input.rpcUrl, txHash)
  return txHash
}

function requireEnv(input: Env, name: keyof Env): string {
  const value = String(input[name] || "").trim()
  if (!value) {
    throw new Error(`${String(name).toLowerCase()}_missing`)
  }
  return value
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const tempRoot = await mkdtemp(join(tmpdir(), "pirate-song-cdr-local-e2e-"))
  const mediaRoot = join(tempRoot, "media")
  const songPath = join(mediaRoot, "song.wav")
  const coverPath = join(mediaRoot, "cover.png")
  const canvasPath = join(mediaRoot, "canvas.mp4")
  const downloadOut = join(tempRoot, "buyer-download.bin")
  await Bun.write(songPath, buildWavBytes(35_000))
  const devVars = readDevVarsFromCwd()
  const envValue = (name: keyof Env): string | undefined => {
    if (Object.prototype.hasOwnProperty.call(process.env, name)) {
      const runtimeValue = process.env[name]
      return runtimeValue != null && String(runtimeValue).trim() ? runtimeValue : undefined
    }
    const devValue = devVars[String(name)]
    return devValue != null && String(devValue).trim() ? String(devValue) : undefined
  }

  const envOverrides: Partial<Env> = {
    OPENROUTER_API_KEY: envValue("OPENROUTER_API_KEY"),
    SONG_LYRICS_LLM_MODEL: envValue("SONG_LYRICS_LLM_MODEL"),
    ELEVENLABS_API_KEY: envValue("ELEVENLABS_API_KEY"),
    LIT_CHIPOTLE_OPERATOR_API_KEY: envValue("LIT_CHIPOTLE_OPERATOR_API_KEY"),
    FILEBASE_S3_ACCESS_KEY: envValue("FILEBASE_S3_ACCESS_KEY"),
    FILEBASE_S3_SECRET_KEY: envValue("FILEBASE_S3_SECRET_KEY"),
    FILEBASE_S3_BUCKET_MUSIC: envValue("FILEBASE_S3_BUCKET_MUSIC"),
    FILEBASE_S3_ENDPOINT: envValue("FILEBASE_S3_ENDPOINT"),
    FILEBASE_S3_REGION: envValue("FILEBASE_S3_REGION"),
    IPFS_GATEWAY_URL: envValue("IPFS_GATEWAY_URL"),
    STORY_AENEID_RPC_URL: envValue("STORY_AENEID_RPC_URL"),
    STORY_CDR_WRITER_PRIVATE_KEY: envValue("STORY_CDR_WRITER_PRIVATE_KEY"),
    STORY_CDR_READ_CONDITION_ADDRESS: envValue("STORY_CDR_READ_CONDITION_ADDRESS"),
    STORY_CDR_WRITE_CONDITION_ADDRESS: envValue("STORY_CDR_WRITE_CONDITION_ADDRESS"),
    STORY_CDR_COMET_RPC_URL: envValue("STORY_CDR_COMET_RPC_URL"),
    STORY_TOKEN_GATE_CONDITION_ADDRESS: envValue("STORY_TOKEN_GATE_CONDITION_ADDRESS"),
    STORY_SIGNED_ACCESS_CONDITION_ADDRESS: envValue("STORY_SIGNED_ACCESS_CONDITION_ADDRESS"),
    STORY_PUBLISH_OPERATOR_PRIVATE_KEY: envValue("STORY_PUBLISH_OPERATOR_PRIVATE_KEY"),
    STORY_ACCESS_CONTROLLER_PRIVATE_KEY: envValue("STORY_ACCESS_CONTROLLER_PRIVATE_KEY"),
    STORY_ENTITLEMENT_TOKEN_ADDRESS: envValue("STORY_ENTITLEMENT_TOKEN_ADDRESS"),
    STORY_SETTLEMENT_PRIVATE_KEY: envValue("STORY_SETTLEMENT_PRIVATE_KEY"),
    STORY_CONTRACT_OWNER_PRIVATE_KEY: envValue("STORY_CONTRACT_OWNER_PRIVATE_KEY"),
    INTERNAL_JOB_RUNNER_TOKEN: envValue("INTERNAL_JOB_RUNNER_TOKEN") || "internal-song-job-token",
  }

  if (args.disableDirectPublish) {
    envOverrides.STORY_PUBLISH_OPERATOR_PRIVATE_KEY = undefined
  }
  if (args.disableSdkWriter) {
    envOverrides.STORY_CDR_WRITER_PRIVATE_KEY = undefined
  }

  const ctx = await createRouteTestContext(envOverrides)
  let shouldCleanup = !args.keepFiles
  const partialSummary: Record<string, unknown> = {
    temp_root: tempRoot,
    keep_files: args.keepFiles,
    step: "boot",
  }
  ;(globalThis as { __songCdrLocalE2ePartialSummary?: Record<string, unknown> }).__songCdrLocalE2ePartialSummary = partialSummary
  try {
    resetRuntimeCaches()
    const writerFundingTxRef = await fundCdrWriterIfNeeded({
      env: ctx.env,
      rpcUrl: String(ctx.env.STORY_AENEID_RPC_URL || "").trim() || "https://rpc.ankr.com/story_aeneid_testnet",
    })
    if (writerFundingTxRef) {
      partialSummary.writer_funding_tx_ref = writerFundingTxRef
    }
    await Bun.write(coverPath, await ensureFfmpegAsset({
      label: "cover",
      outputPath: coverPath,
      args: ["-f", "lavfi", "-i", "color=c=orange:s=1000x1000:d=1", "-frames:v", "1"],
    }))
    await Bun.write(canvasPath, await ensureFfmpegAsset({
      label: "canvas",
      outputPath: canvasPath,
      args: ["-f", "lavfi", "-i", "color=c=blue:s=720x1280:d=3", "-c:v", "libx264", "-pix_fmt", "yuv420p"],
    }))

    const creator = await exchangeJwt(ctx.env, `song-cdr-creator-${randomUUID()}`)
    const buyer = await exchangeJwt(ctx.env, `song-cdr-buyer-${randomUUID()}`)
    const creatorWallet = privateKeyToAccount(randomPrivateKey())
    const buyerPrivateKey = randomPrivateKey()
    const buyerWallet = privateKeyToAccount(buyerPrivateKey)
    const creatorWalletAttachmentId = await setPrimaryWalletAttachment(ctx.env, creator.userId, creatorWallet.address)
    const buyerWalletAttachmentId = await setPrimaryWalletAttachment(ctx.env, buyer.userId, buyerWallet.address)
    partialSummary.creator_user_id = creator.userId
    partialSummary.buyer_user_id = buyer.userId
    partialSummary.creator_wallet_attachment_id = creatorWalletAttachmentId
    partialSummary.buyer_wallet_attachment_id = buyerWalletAttachmentId
    partialSummary.buyer_wallet_address = buyerWallet.address

    const namespaceVerificationId = await prepareVerifiedNamespace(
      ctx.env,
      creator.accessToken,
      `PirateSongCdrLive${Date.now()}`,
    )
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Pirate Song CDR Local Live",
      namespace: {
        namespace_verification_id: namespaceVerificationId,
      },
    }, ctx.env, creator.accessToken)
    if (communityCreate.status !== 202) {
      throw new Error(`community_create_failed:${communityCreate.status}:${await communityCreate.text()}`)
    }
    const communityCreateBody = await json(communityCreate) as { community: { community_id: string } }
    const communityId = communityCreateBody.community.community_id
    partialSummary.community_id = communityId

    const songBytes = new Uint8Array(await readFile(songPath))
    const coverBytes = new Uint8Array(await readFile(coverPath))
    const canvasBytes = new Uint8Array(await readFile(canvasPath))

    const uploadedPrimary = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: creator.accessToken,
      communityId,
      artifactKind: "primary_audio",
      mimeType: "audio/wav",
      filename: basename(songPath),
      bytes: songBytes,
    })
    const uploadedCover = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: creator.accessToken,
      communityId,
      artifactKind: "cover_art",
      mimeType: "image/png",
      filename: basename(coverPath),
      bytes: coverBytes,
    })
    const uploadedCanvas = await createCompletedSongArtifactUpload({
      env: ctx.env,
      accessToken: creator.accessToken,
      communityId,
      artifactKind: "canvas_video",
      mimeType: "video/mp4",
      filename: basename(canvasPath),
      bytes: canvasBytes,
    })

    const bundleCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/song-artifacts`,
      {
        primary_audio: {
          storage_ref: uploadedPrimary.storage_ref,
          mime_type: uploadedPrimary.mime_type,
          size_bytes: uploadedPrimary.size_bytes,
          content_hash: uploadedPrimary.content_hash,
          duration_ms: 35_000,
        },
        cover_art: {
          storage_ref: uploadedCover.storage_ref,
          mime_type: uploadedCover.mime_type,
          size_bytes: uploadedCover.size_bytes,
          content_hash: uploadedCover.content_hash,
          width: 1000,
          height: 1000,
        },
        canvas_video: {
          storage_ref: uploadedCanvas.storage_ref,
          mime_type: uploadedCanvas.mime_type,
          size_bytes: uploadedCanvas.size_bytes,
          content_hash: uploadedCanvas.content_hash,
          width: 720,
          height: 1280,
          duration_ms: 3_000,
        },
        preview_window: {
          start_ms: 5_000,
          duration_ms: 30_000,
        },
        lyrics: [
          "This is a local live song flow test.",
          "Preview should derive, publish should succeed.",
          "Translation and alignment should complete.",
          "Buyer entitlement should unlock CDR download.",
        ].join("\n"),
      },
      ctx.env,
      creator.accessToken,
    )
    if (bundleCreate.status !== 201) {
      throw new Error(`bundle_create_failed:${bundleCreate.status}:${await bundleCreate.text()}`)
    }
    const bundleCreateBody = await json(bundleCreate) as { song_artifact_bundle_id: string }

    const previewReadyBundle = await waitForPreviewReady({
      env: ctx.env,
      communityId,
      bundleId: bundleCreateBody.song_artifact_bundle_id,
      accessToken: creator.accessToken,
      internalJobRunnerToken: requireEnv(ctx.env, "INTERNAL_JOB_RUNNER_TOKEN"),
    })
    partialSummary.bundle_id = bundleCreateBody.song_artifact_bundle_id
    partialSummary.preview_status = previewReadyBundle.preview_status

    const createPost = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        post_type: "song",
        identity_mode: "public",
        song_mode: "original",
        rights_basis: "original",
        access_mode: "locked",
        title: "Song CDR Local Live",
        song_artifact_bundle_id: bundleCreateBody.song_artifact_bundle_id,
        idempotency_key: `song-cdr-local-live-${randomUUID()}`,
      },
      ctx.env,
      creator.accessToken,
    )
    if (createPost.status !== 201) {
      throw new Error(`post_create_failed:${createPost.status}:${await createPost.text()}`)
    }
    const createPostBody = await json(createPost) as { post_id: string; asset_id: string | null }
    if (!createPostBody.asset_id) {
      throw new Error("asset_id_missing")
    }
    partialSummary.asset_id = createPostBody.asset_id

    partialSummary.step = "bundle_enrichment"
    const enrichedBundle = await waitForBundleEnrichment({
      env: ctx.env,
      communityId,
      bundleId: bundleCreateBody.song_artifact_bundle_id,
      accessToken: creator.accessToken,
      internalJobRunnerToken: requireEnv(ctx.env, "INTERNAL_JOB_RUNNER_TOKEN"),
    })
    partialSummary.step = "locked_delivery"
    const deliveryReadyAsset = await waitForLockedDeliveryReady({
      env: ctx.env,
      communityId,
      assetId: createPostBody.asset_id,
      accessToken: creator.accessToken,
      internalJobRunnerToken: requireEnv(ctx.env, "INTERNAL_JOB_RUNNER_TOKEN"),
    })
    partialSummary.step = "grant_publish_operator"
    console.error("[song-cdr-local-e2e] step grant_publish_operator")
    const publishOperatorGrantTxRef = await grantStoryPublishOperatorIfPossible({
      env: ctx.env,
      rpcUrl: String(ctx.env.STORY_AENEID_RPC_URL || "").trim() || "https://rpc.ankr.com/story_aeneid_testnet",
    })
    partialSummary.step = "configure_entitlement_class"
    console.error("[song-cdr-local-e2e] step configure_entitlement_class")
    const entitlementClassTxRef = await configureEntitlementClassIfPossible({
      env: ctx.env,
      asset: deliveryReadyAsset,
      rpcUrl: String(ctx.env.STORY_AENEID_RPC_URL || "").trim() || "https://rpc.ankr.com/story_aeneid_testnet",
    })
    partialSummary.story_entitlement_token_id = deliveryReadyAsset.story_entitlement_token_id
    partialSummary.story_asset_version_id = deliveryReadyAsset.story_asset_version_id
    partialSummary.story_cdr_vault_uuid = deliveryReadyAsset.story_cdr_vault_uuid
    partialSummary.publish_operator_grant_tx_ref = publishOperatorGrantTxRef
    partialSummary.entitlement_class_tx_ref = entitlementClassTxRef
    partialSummary.step = "story_publish"
    console.error("[song-cdr-local-e2e] step story_publish")
    let publishedAsset: AssetReadResponse
    let storyPublishError: string | null = null
    try {
      publishedAsset = await waitForStoryPublish({
        env: ctx.env,
        communityId,
        assetId: createPostBody.asset_id,
        accessToken: creator.accessToken,
        internalJobRunnerToken: requireEnv(ctx.env, "INTERNAL_JOB_RUNNER_TOKEN"),
      })
    } catch (error) {
      storyPublishError = error instanceof Error ? error.message : String(error)
      publishedAsset = await getAsset(ctx.env, communityId, createPostBody.asset_id, creator.accessToken)
    }
    partialSummary.story_status = publishedAsset.story_status
    partialSummary.story_error = publishedAsset.story_error
    partialSummary.story_publish_tx_ref = publishedAsset.story_publish_tx_ref
    console.error(
      `[song-cdr-local-e2e] story_status ${publishedAsset.story_status}${publishedAsset.story_publish_tx_ref ? ` tx=${publishedAsset.story_publish_tx_ref}` : ""}${storyPublishError ? ` error=${storyPublishError}` : ""}`,
    )

    if (args.stopAfterStoryPublish) {
      const summary = {
        community_id: communityId,
        creator_user_id: creator.userId,
        buyer_user_id: buyer.userId,
        creator_wallet_attachment_id: creatorWalletAttachmentId,
        buyer_wallet_attachment_id: buyerWalletAttachmentId,
        bundle_id: bundleCreateBody.song_artifact_bundle_id,
        asset_id: createPostBody.asset_id,
        preview_status: previewReadyBundle.preview_status,
        translation_status: enrichedBundle.translation_status,
        alignment_status: enrichedBundle.alignment_status,
        moderation_status: enrichedBundle.moderation_status,
        locked_delivery_status: deliveryReadyAsset.locked_delivery_status,
        locked_delivery_ref: deliveryReadyAsset.locked_delivery_ref,
        story_status: publishedAsset.story_status,
        story_error: publishedAsset.story_error,
        story_publish_tx_ref: publishedAsset.story_publish_tx_ref,
        story_asset_version_id: publishedAsset.story_asset_version_id,
        story_cdr_vault_uuid: publishedAsset.story_cdr_vault_uuid,
        story_entitlement_token_id: publishedAsset.story_entitlement_token_id,
        publish_operator_grant_tx_ref: publishOperatorGrantTxRef,
        entitlement_class_tx_ref: entitlementClassTxRef,
        stopped_after_story_publish: true,
      }
      console.log(JSON.stringify(summary, null, 2))
      return
    }

    const listingCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/listings`,
      {
        asset_id: createPostBody.asset_id,
        price_usd: 7,
        regional_pricing_enabled: false,
        status: "active",
      },
      ctx.env,
      creator.accessToken,
    )
    if (listingCreate.status !== 201) {
      throw new Error(`listing_create_failed:${listingCreate.status}:${await listingCreate.text()}`)
    }
    const listingBody = await json(listingCreate) as { listing_id: string }

    const quoteCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/purchase-quotes`,
      {
        listing_id: listingBody.listing_id,
        client_estimated_slippage_bps: 0,
        client_estimated_hop_count: 0,
        ...(String(ctx.env.STORY_SETTLEMENT_PRIVATE_KEY || "").trim() ? {
          destination_settlement_amount_atomic: "1",
          destination_settlement_decimals: 18,
        } : {}),
      },
      ctx.env,
      buyer.accessToken,
    )
    if (quoteCreate.status !== 200) {
      throw new Error(`quote_create_failed:${quoteCreate.status}:${await quoteCreate.text()}`)
    }
    const quoteBody = await json(quoteCreate) as { quote_id: string }
    partialSummary.quote_id = quoteBody.quote_id

    const settlementCreate = await requestJson(
      `http://pirate.test/communities/${communityId}/purchase-settlements`,
      {
        quote_id: quoteBody.quote_id,
        settlement_wallet_attachment_id: buyerWalletAttachmentId,
        ...(String(ctx.env.STORY_SETTLEMENT_PRIVATE_KEY || "").trim()
          ? {}
          : { settlement_tx_ref: `story:manual:${randomUUID()}` }),
      },
      ctx.env,
      buyer.accessToken,
    )
    if (settlementCreate.status !== 200) {
      throw new Error(`settlement_failed:${settlementCreate.status}:${await settlementCreate.text()}`)
    }
    const settlementBody = await json(settlementCreate) as { purchase_id: string; settlement_tx_ref: string }
    partialSummary.purchase_id = settlementBody.purchase_id
    partialSummary.settlement_tx_ref = settlementBody.settlement_tx_ref
    partialSummary.story_purchase_ref = buildStoryPurchaseRef({
      communityId,
      quoteId: quoteBody.quote_id,
    })

    const manifestResponse = await app.request(
      `http://pirate.test/communities/${communityId}/assets/${createPostBody.asset_id}/cdr-manifest?wallet_attachment_id=${encodeURIComponent(buyerWalletAttachmentId)}`,
      {
        headers: {
          authorization: `Bearer ${buyer.accessToken}`,
        },
      },
      ctx.env,
    )
    if (manifestResponse.status !== 200) {
      throw new Error(`cdr_manifest_failed:${manifestResponse.status}:${await manifestResponse.text()}`)
    }
    const manifest = await json(manifestResponse) as CdrManifestResponse
    partialSummary.cdr_manifest = {
      vault_uuid: manifest.vault_uuid,
      encrypted_cid: manifest.encrypted_cid,
      decision_reason: manifest.decision_reason,
      rpc_url: manifest.rpc_url,
      dkg_source: manifest.dkg_source,
      comet_rpc_url: manifest.comet_rpc_url,
      access_aux_data: manifest.access_aux_data,
      condition_data: manifest.condition_data,
    }
    const buyerFundingTxRef = await fundBuyerWalletIfNeeded({
      env: ctx.env,
      buyerAddress: buyerWallet.address,
      rpcUrl: manifest.rpc_url,
    })
    partialSummary.buyer_funding_tx_ref = buyerFundingTxRef
    partialSummary.story_purchase_settled = await rpcRequest({
      rpcUrl: manifest.rpc_url,
      method: "eth_call",
      params: [{
        to: String(ctx.env.STORY_MARKETPLACE_SETTLEMENT_ADDRESS || "0xFECcC2cF8C9946E1384eF5733B509ac70677c5bd").trim(),
        data: `0x901259ca${String(partialSummary.story_purchase_ref).replace(/^0x/, "")}`,
      }, "latest"],
    }) as string

    if (deliveryReadyAsset.story_entitlement_token_id) {
      const balanceResult = await rpcRequest({
        rpcUrl: manifest.rpc_url,
        method: "eth_call",
        params: [{
          to: String(ctx.env.STORY_ENTITLEMENT_TOKEN_ADDRESS || "0x0d3eF43a98077c9a71853309EE4C6665C20C1Fa6").trim(),
          data: encodeFunctionData({
            abi: [{
              type: "function",
              name: "balanceOf",
              stateMutability: "view",
              inputs: [
                { name: "account", type: "address" },
                { name: "id", type: "uint256" },
              ],
              outputs: [{ name: "", type: "uint256" }],
            }],
            functionName: "balanceOf",
            args: [buyerWallet.address, BigInt(deliveryReadyAsset.story_entitlement_token_id)],
          }),
        }, "latest"],
      }) as string
      partialSummary.buyer_entitlement_balance = BigInt(balanceResult).toString()
    }

    await initWasm()
    const publicClient = createPublicClient({
      transport: http(manifest.rpc_url),
    }) as unknown as ConstructorParameters<typeof CDRClient>[0]["publicClient"]
    const walletClient = createWalletClient({
      account: buyerWallet,
      transport: http(manifest.rpc_url),
    }) as unknown as NonNullable<ConstructorParameters<typeof CDRClient>[0]["walletClient"]>
    const client = new CDRClient({
      network: manifest.network,
      publicClient,
      walletClient,
      dkgSource: manifest.dkg_source,
      cometRpcUrl: manifest.comet_rpc_url || undefined,
    })
    const storageProvider = new GatewayStorageProvider(
      manifest.gateway_base_url,
      manifest.encrypted_fetch_url,
    )
    const download = await downloadFileWithRetry({
      client,
      uuid: manifest.vault_uuid,
      accessAuxData: manifest.access_aux_data as `0x${string}`,
      storageProvider,
      skipCidVerification: true,
    })
    if (download.cid !== manifest.encrypted_cid) {
      throw new Error(`encrypted_cid_mismatch:${manifest.encrypted_cid}:${download.cid}`)
    }
    if (!storageProvider.lastDownloadedBytes) {
      throw new Error("encrypted_payload_bytes_missing")
    }
    await assertIpfsUnixFsCid({
      bytes: storageProvider.lastDownloadedBytes,
      expectedCid: manifest.encrypted_cid,
      label: "encrypted_payload",
    })
    await writeFile(downloadOut, download.content)

    const sourceSha = sha256Hex(songBytes)
    const downloadedSha = sha256Hex(download.content)
    if (sourceSha !== downloadedSha) {
      throw new Error("downloaded_bytes_do_not_match_source")
    }

    const summary = {
      community_id: communityId,
      creator_user_id: creator.userId,
      buyer_user_id: buyer.userId,
      creator_wallet_attachment_id: creatorWalletAttachmentId,
      buyer_wallet_attachment_id: buyerWalletAttachmentId,
      buyer_wallet_address: buyerWallet.address,
      song_upload: {
        storage_ref: uploadedPrimary.storage_ref,
        storage_provider: uploadedPrimary.storage_provider,
        storage_bucket: uploadedPrimary.storage_bucket,
        storage_object_key: uploadedPrimary.storage_object_key,
        gateway_url: uploadedPrimary.gateway_url,
      },
      cover_upload: {
        storage_ref: uploadedCover.storage_ref,
        storage_provider: uploadedCover.storage_provider,
        storage_bucket: uploadedCover.storage_bucket,
        storage_object_key: uploadedCover.storage_object_key,
        gateway_url: uploadedCover.gateway_url,
      },
      canvas_upload: {
        storage_ref: uploadedCanvas.storage_ref,
        storage_provider: uploadedCanvas.storage_provider,
        storage_bucket: uploadedCanvas.storage_bucket,
        storage_object_key: uploadedCanvas.storage_object_key,
        gateway_url: uploadedCanvas.gateway_url,
      },
      bundle_id: bundleCreateBody.song_artifact_bundle_id,
      preview_status: previewReadyBundle.preview_status,
      preview_audio: previewReadyBundle.preview_audio,
      translation_status: enrichedBundle.translation_status,
      alignment_status: enrichedBundle.alignment_status,
      moderation_status: enrichedBundle.moderation_status,
      moderation_result: enrichedBundle.moderation_result ?? null,
      asset_id: createPostBody.asset_id,
      locked_delivery_status: deliveryReadyAsset.locked_delivery_status,
      locked_delivery_ref: deliveryReadyAsset.locked_delivery_ref,
      story_status: publishedAsset.story_status,
      story_error: publishedAsset.story_error,
      story_publish_error: storyPublishError,
      entitlement_class_tx_ref: entitlementClassTxRef,
      story_publish_tx_ref: publishedAsset.story_publish_tx_ref,
      story_cdr_vault_uuid: publishedAsset.story_cdr_vault_uuid,
      story_cdr_encrypted_cid: publishedAsset.story_cdr_encrypted_cid,
      story_entitlement_token_id: publishedAsset.story_entitlement_token_id,
      story_read_condition: publishedAsset.story_read_condition,
      listing_id: listingBody.listing_id,
      quote_id: quoteBody.quote_id,
      purchase_id: settlementBody.purchase_id,
      settlement_tx_ref: settlementBody.settlement_tx_ref,
      cdr_manifest: {
        vault_uuid: manifest.vault_uuid,
        encrypted_cid: manifest.encrypted_cid,
        gateway_base_url: manifest.gateway_base_url,
        decision_reason: manifest.decision_reason,
        signer_family: manifest.signer_family,
      },
      cdr_download: {
        buyer_funding_tx_ref: buyerFundingTxRef,
        tx_hash: download.txHash,
        download_out: downloadOut,
        source_sha256: sourceSha,
        downloaded_sha256: downloadedSha,
      },
      media_files: {
        song: songPath,
        cover: coverPath,
        canvas: canvasPath,
      },
      storage_mode: uploadedPrimary.storage_provider,
    }
    console.log(JSON.stringify(summary, null, 2))
    partialSummary.completed = true
  } finally {
    resetRuntimeCaches()
    if (shouldCleanup) {
      delete (globalThis as { __songCdrLocalE2ePartialSummary?: Record<string, unknown> }).__songCdrLocalE2ePartialSummary
    }
    if (shouldCleanup) {
      await ctx.cleanup().catch(() => {})
      await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
    } else {
      console.error(`[song-cdr-local-e2e] kept temp files at ${tempRoot}`)
    }
  }
}

await main().catch((error) => {
  try {
    const summary = (globalThis as { __songCdrLocalE2ePartialSummary?: Record<string, unknown> }).__songCdrLocalE2ePartialSummary
    if (summary) {
      // eslint-disable-next-line no-console
      console.error(`[song-cdr-local-e2e] partial_state ${JSON.stringify(summary, null, 2)}`)
    } else {
      // eslint-disable-next-line no-console
      console.error("[song-cdr-local-e2e] partial_state_unavailable_in_catch")
    }
  } catch {}
  console.error(`[song-cdr-local-e2e] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
