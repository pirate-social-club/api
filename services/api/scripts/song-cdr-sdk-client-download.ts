#!/usr/bin/env bun

import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { createPublicClient, createWalletClient, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { CDRClient, initWasm, type StorageProvider } from "../src/lib/posts/story-cdr-sdk-client"
import { readDevVarsFromCwd } from "./_lib/dev-vars"
import { assertIpfsUnixFsCid } from "./_lib/ipfs-cid"

type AssetCdrManifestResponse = {
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
  signer_family: "story-access-controller"
  signer_address: string
  verifier_contract: string
  namespace: string
  access_ref: string
  scope: "asset.owner" | "asset.share"
  expiry: string
  digest: string
  condition_data: string
  access_aux_data: string
  signature: string
}

type ParsedArgs = {
  baseUrl: string
  communityId: string
  assetId: string
  buyerToken: string
  buyerWalletAttachmentId: string
  buyerWalletPrivateKey: `0x${string}`
  downloadOut: string | null
  expectFile: string | null
  skipCidVerification: boolean
}

function resolveEnv(name: string, fallback = ""): string {
  return process.env[name] || readDevVarsFromCwd()[name] || fallback
}

function usage(): never {
  console.error(`Usage:
  bun pirate-api/services/api/scripts/song-cdr-sdk-client-download.ts \\
    --base-url URL \\
    --community-id COMMUNITY_ID \\
    --asset-id ASSET_ID \\
    --buyer-token TOKEN \\
    --buyer-wallet-attachment-id WALLET_ATTACHMENT_ID \\
    --buyer-wallet-private-key 0x... [options]

Options:
  --download-out /tmp/song.bin
  --expect-file /absolute/path/full-song.mp3
  --skip-cid-verification true

Environment fallbacks:
  API_BASE_URL
  COMMUNITY_ID
  ASSET_ID
  BUYER_TOKEN
  BUYER_WALLET_ATTACHMENT_ID
  BUYER_WALLET_PRIVATE_KEY
  DOWNLOAD_OUT
  EXPECT_FILE
  SKIP_CID_VERIFICATION
`)
  process.exit(1)
}

function parseArgs(argv: string[]): ParsedArgs {
  const map = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key?.startsWith("--")) {
      usage()
    }
    const value = argv[index + 1]
    if (value == null) {
      usage()
    }
    map.set(key.slice(2), value)
    index += 1
  }

  const readString = (name: string, envName = name.replace(/-/g, "_").toUpperCase()): string | null => {
    const value = map.get(name) ?? resolveEnv(envName)
    const trimmed = String(value || "").trim()
    return trimmed || null
  }

  const required = (value: string | null, label: string): string => {
    if (!value) {
      throw new Error(`${label}_missing`)
    }
    return value
  }

  const buyerWalletPrivateKey = required(
    readString("buyer-wallet-private-key", "BUYER_WALLET_PRIVATE_KEY"),
    "buyer_wallet_private_key",
  )
  if (!/^0x[a-fA-F0-9]{64}$/.test(buyerWalletPrivateKey)) {
    throw new Error("buyer_wallet_private_key_invalid")
  }

  return {
    baseUrl: required(readString("base-url", "API_BASE_URL"), "base_url").replace(/\/+$/, ""),
    communityId: required(readString("community-id", "COMMUNITY_ID"), "community_id"),
    assetId: required(readString("asset-id", "ASSET_ID"), "asset_id"),
    buyerToken: required(readString("buyer-token", "BUYER_TOKEN"), "buyer_token"),
    buyerWalletAttachmentId: required(
      readString("buyer-wallet-attachment-id", "BUYER_WALLET_ATTACHMENT_ID"),
      "buyer_wallet_attachment_id",
    ),
    buyerWalletPrivateKey: buyerWalletPrivateKey as `0x${string}`,
    downloadOut: readString("download-out", "DOWNLOAD_OUT"),
    expectFile: readString("expect-file", "EXPECT_FILE"),
    skipCidVerification: String(readString("skip-cid-verification", "SKIP_CID_VERIFICATION") || "").trim().toLowerCase() === "true",
  }
}

async function jsonRequest<T>(input: {
  method: string
  url: string
  token: string
}): Promise<T> {
  const response = await fetch(input.url, {
    method: input.method,
    headers: {
      authorization: `Bearer ${input.token}`,
    },
  })
  const raw = await response.text()
  if (!response.ok) {
    throw new Error(`http_${response.status}:${input.method}:${input.url}:${raw.slice(0, 500)}`)
  }
  return raw ? JSON.parse(raw) as T : null as T
}

async function readFileBytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path))
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
      console.warn(`[song-cdr-sdk-client-download] retrying vault read after transient empty-data response (${attempt + 1}/6)`)
      await Bun.sleep(5000)
    }
  }
  throw lastError ?? new Error("cdr_download_failed")
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
    if (!normalizedCid) {
      throw new Error("cdr_manifest_encrypted_cid_missing")
    }
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
      lastError = `gateway_download_failed:${response.status}:${raw.slice(0, 500)}`
      if (response.status !== 404 || attempt === 23) {
        throw new Error(lastError)
      }
      await Bun.sleep(5000)
    }
    throw new Error(lastError)
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  console.log("[song-cdr-sdk-client-download] requesting CDR manifest")
  const manifest = await jsonRequest<AssetCdrManifestResponse>({
    method: "GET",
    url: `${args.baseUrl}/communities/${args.communityId}/assets/${args.assetId}/cdr-manifest?wallet_attachment_id=${encodeURIComponent(args.buyerWalletAttachmentId)}`,
    token: args.buyerToken,
  })

  await initWasm()
  const account = privateKeyToAccount(args.buyerWalletPrivateKey)
  const publicClient = createPublicClient({
    transport: http(manifest.rpc_url),
  }) as unknown as ConstructorParameters<typeof CDRClient>[0]["publicClient"]
  const walletClient = createWalletClient({
    account,
    transport: http(manifest.rpc_url),
  }) as unknown as NonNullable<ConstructorParameters<typeof CDRClient>[0]["walletClient"]>
  const client = new CDRClient({
    network: manifest.network,
    publicClient,
    walletClient,
    dkgSource: manifest.dkg_source,
    cometRpcUrl: manifest.comet_rpc_url || undefined,
  })
  const storageProvider = new GatewayStorageProvider(manifest.gateway_base_url, manifest.encrypted_fetch_url)

  console.log("[song-cdr-sdk-client-download] downloading and decrypting via SDK consumer path")
  const result = await downloadFileWithRetry({
    client,
    uuid: manifest.vault_uuid,
    accessAuxData: manifest.access_aux_data as `0x${string}`,
    storageProvider,
    skipCidVerification: true,
  })

  if (result.cid !== manifest.encrypted_cid) {
    throw new Error(`encrypted_cid_mismatch:${manifest.encrypted_cid}:${result.cid}`)
  }
  if (!args.skipCidVerification) {
    if (!storageProvider.lastDownloadedBytes) {
      throw new Error("encrypted_payload_bytes_missing")
    }
    await assertIpfsUnixFsCid({
      bytes: storageProvider.lastDownloadedBytes,
      expectedCid: manifest.encrypted_cid,
      label: "encrypted_payload",
    })
  }

  if (args.downloadOut) {
    await writeFile(args.downloadOut, result.content)
  }

  let matchesExpected: boolean | null = null
  let expectedSha256: string | null = null
  if (args.expectFile) {
    const expectedBytes = await readFileBytes(args.expectFile)
    matchesExpected = Buffer.compare(Buffer.from(result.content), Buffer.from(expectedBytes)) === 0
    expectedSha256 = sha256Hex(expectedBytes)
    if (!matchesExpected) {
      throw new Error("sdk_downloaded_bytes_do_not_match_expected_file")
    }
  }

  console.log(JSON.stringify({
    community_id: manifest.community_id,
    asset_id: manifest.asset_id,
    delivery_ref: manifest.delivery_ref,
    vault_uuid: manifest.vault_uuid,
    encrypted_cid: manifest.encrypted_cid,
    read_tx_hash: result.txHash,
    downloaded_sha256: sha256Hex(result.content),
    expected_sha256: expectedSha256,
    downloaded_matches_expected: matchesExpected,
    download_out: args.downloadOut,
    wallet_attachment_id: manifest.wallet_attachment_id,
    signer_family: manifest.signer_family,
    signer_address: manifest.signer_address,
  }, null, 2))
}

await main().catch((error) => {
  console.error(`[song-cdr-sdk-client-download] ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
