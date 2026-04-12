import { createHash } from "node:crypto"
import { privateKeyToAccount } from "viem/accounts"
import type { Asset, AssetAccessProofResponse, Env } from "../../types"
import { getStoryAeneidDeliveryDefaults } from "./story-delivery-config"
import { readLocalLitActionSource } from "../lit-action-source"

const DEFAULT_LIT_CHIPOTLE_API_BASE_URL = "https://api.dev.litprotocol.com"
const DEFAULT_STORY_ACCESS_CONTROLLER_PKP_ADDRESS = "0x2125952f22Ad971df5645E31a613fe42DCC42c48"
const DEFAULT_ACCESS_PROOF_TTL_SECONDS = 300
const HASH_PROOF_SELECTOR = "0x9dc58ff3"
const SCOPE_ASSET_OWNER_HASH = "0x11827a267b38144fcbb99ddb8ba80bf83799b984d84a552db3b152604cdb516b"
const SCOPE_ASSET_SHARE_HASH = "0x1561849a4ad6a6549cd67372669a9ebd635f74333847603452e5833327457dbd"

type AccessScope = "asset.owner" | "asset.share"

type AccessProofRecord = {
  vaultUuid: number
  caller: string
  accessRef: string
  scope: string
  expiry: bigint
  namespace: string
}

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

function requireHexBytes(value: string | null | undefined, label: string): string {
  const normalized = String(value || "").trim()
  if (!/^0x[a-fA-F0-9]+$/.test(normalized) || normalized.length % 2 !== 0) {
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

function parsePositiveInt(value: string | null | undefined, fallback: number): number {
  const parsed = Number(String(value || "").trim())
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.max(1, Math.trunc(parsed))
}

function encodeUintWord(value: bigint): string {
  if (value < 0n) {
    throw new Error("uint_value_invalid")
  }
  return value.toString(16).padStart(64, "0")
}

function encodeAddressWord(value: string): string {
  return requireAddress(value, "address_word").toLowerCase().replace(/^0x/, "").padStart(64, "0")
}

function encodeBytes32Word(value: string): string {
  return requireBytes32(value, "bytes32_word").replace(/^0x/, "")
}

function padHexData(value: string): string {
  const normalized = requireHexBytes(value, "dynamic_hex").replace(/^0x/, "")
  const remainder = normalized.length % 64
  return remainder === 0 ? normalized : normalized.padEnd(normalized.length + (64 - remainder), "0")
}

function readLocalActionSource(): string {
  return readLocalLitActionSource("story-access-controller/sign-access-proof.js")
}

async function fetchTextFromIpfs(ref: string, env: Env): Promise<string> {
  const normalizedRef = String(ref || "").trim()
  if (!normalizedRef.startsWith("ipfs://")) {
    throw new Error("lit_action_ref_invalid")
  }
  const gatewayBase = String(env.IPFS_GATEWAY_URL || "https://psc.myfilebase.com/ipfs").trim().replace(/\/+$/, "")
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

function buildHashProofCalldata(proof: AccessProofRecord): string {
  const scopeHash = proof.scope === "asset.owner" ? SCOPE_ASSET_OWNER_HASH : SCOPE_ASSET_SHARE_HASH
  return `0x${HASH_PROOF_SELECTOR.slice(2)}${[
    encodeUintWord(BigInt(proof.vaultUuid)),
    encodeAddressWord(proof.caller),
    encodeBytes32Word(proof.accessRef),
    encodeBytes32Word(scopeHash),
    encodeUintWord(proof.expiry),
    encodeBytes32Word(proof.namespace),
  ].join("")}`
}

function buildConditionData(namespace: string): string {
  return `0x${encodeBytes32Word(namespace)}`
}

function buildAccessAuxData(input: {
  proof: AccessProofRecord
  signature: string
}): string {
  const scopeHash = input.proof.scope === "asset.owner" ? SCOPE_ASSET_OWNER_HASH : SCOPE_ASSET_SHARE_HASH
  const signature = requireHexBytes(input.signature, "signature")
  const signatureBody = signature.replace(/^0x/, "")
  const offsetWord = encodeUintWord(224n)
  const signatureLengthWord = encodeUintWord(BigInt(signatureBody.length / 2))
  const paddedSignature = padHexData(signature)
  return `0x${[
    encodeUintWord(BigInt(input.proof.vaultUuid)),
    encodeAddressWord(input.proof.caller),
    encodeBytes32Word(input.proof.accessRef),
    encodeBytes32Word(scopeHash),
    encodeUintWord(input.proof.expiry),
    encodeBytes32Word(input.proof.namespace),
    offsetWord,
    signatureLengthWord,
    paddedSignature,
  ].join("")}`
}

function buildAccessRef(input: {
  asset: Asset
  userId: string
  walletAttachmentId: string
  scope: AccessScope
}): string {
  return `0x${createHash("sha256").update(
    `asset-access:${input.asset.asset_id}:${input.userId}:${input.walletAttachmentId}:${input.scope}`,
  ).digest("hex")}`
}

export async function issueStoryAssetAccessProofViaLit(input: {
  env: Env
  asset: Asset
  userId: string
  walletAttachmentId: string
  callerAddress: string
  decisionReason: "creator" | "moderator" | "purchase_entitlement"
  deliveryRef: string
}): Promise<AssetAccessProofResponse> {
  const usageApiKey = maybe(input.env.LIT_CHIPOTLE_ACCESS_CONTROLLER_API_KEY)
  if (!usageApiKey) {
    throw new Error("lit_chipotle_access_controller_api_key_missing")
  }

  const defaults = getStoryAeneidDeliveryDefaults()
  const rpcUrl = maybe(input.env.STORY_AENEID_RPC_URL) || defaults.rpcUrl
  if (!rpcUrl) {
    throw new Error("story_aeneid_rpc_url_missing")
  }
  const verifierContract = requireAddress(
    maybe(input.env.STORY_SIGNED_ACCESS_CONDITION_ADDRESS) || defaults.signedAccessConditionV1,
    "story_signed_access_condition_address",
  )
  const signerAddress = requireAddress(
    maybe(input.env.STORY_ACCESS_CONTROLLER_PKP_ADDRESS) || defaults.accessProofSigner || DEFAULT_STORY_ACCESS_CONTROLLER_PKP_ADDRESS,
    "story_access_controller_pkp_address",
  ).toLowerCase()
  const namespace = requireBytes32(input.asset.story_namespace, "story_namespace")
  const vaultUuid = Number(input.asset.story_cdr_vault_uuid ?? 0)
  if (!Number.isInteger(vaultUuid) || vaultUuid <= 0) {
    throw new Error("story_cdr_vault_uuid_missing")
  }

  const scope: AccessScope = input.decisionReason === "purchase_entitlement" ? "asset.share" : "asset.owner"
  const expirySeconds = parsePositiveInt(input.env.STORY_ACCESS_PROOF_TTL_SECONDS, DEFAULT_ACCESS_PROOF_TTL_SECONDS)
  const expiryDate = new Date(Date.now() + (expirySeconds * 1000))
  const proof: AccessProofRecord = {
    vaultUuid,
    caller: requireAddress(input.callerAddress, "caller_address"),
    accessRef: buildAccessRef({
      asset: input.asset,
      userId: input.userId,
      walletAttachmentId: input.walletAttachmentId,
      scope,
    }),
    scope,
    expiry: BigInt(Math.floor(expiryDate.getTime() / 1000)),
    namespace,
  }
  const digest = requireBytes32(String(await rpcRequest({
    rpcUrl,
    method: "eth_call",
    params: [
      {
        to: verifierContract,
        data: buildHashProofCalldata(proof),
      },
      "latest",
    ],
  }) || ""), "access_proof_digest")

  const actionSource = maybe(input.env.STORY_ACCESS_CONTROLLER_SIGN_ACCESS_PROOF_ACTION_CID)
    ? await fetchTextFromIpfs(String(input.env.STORY_ACCESS_CONTROLLER_SIGN_ACCESS_PROOF_ACTION_CID), input.env)
    : readLocalActionSource()
  const litBaseUrl = (maybe(input.env.LIT_CHIPOTLE_API_BASE_URL) || DEFAULT_LIT_CHIPOTLE_API_BASE_URL).replace(/\/+$/, "")
  const execution = await litApiRequest({
    baseUrl: litBaseUrl,
    apiKey: usageApiKey,
    body: {
      code: actionSource,
      js_params: {
        digest,
        expectedSignerAddress: signerAddress,
        expectedSignerPublicKey: maybe(input.env.STORY_ACCESS_CONTROLLER_PKP_PUBLIC_KEY) || null,
      },
    },
  }) as { response?: string | { signerAddress?: string; signature?: string } }

  const payload = typeof execution.response === "string"
    ? JSON.parse(execution.response)
    : execution.response
  const actualSignerAddress = String(payload?.signerAddress || "").toLowerCase()
  if (actualSignerAddress !== signerAddress) {
    throw new Error(`lit_action_signer_mismatch:${JSON.stringify({ actual: actualSignerAddress, expected: signerAddress })}`)
  }
  const signature = requireHexBytes(String(payload?.signature || ""), "signature")

  return {
    asset_id: input.asset.asset_id,
    community_id: input.asset.community_id,
    access_mode: "locked",
    decision_reason: input.decisionReason,
    delivery_ref: input.deliveryRef,
    wallet_attachment_id: input.walletAttachmentId,
    caller_address: proof.caller,
    signer_family: "story-access-controller",
    signer_address: signerAddress,
    verifier_contract: verifierContract,
    vault_uuid: vaultUuid,
    namespace,
    access_ref: proof.accessRef,
    scope,
    expiry: expiryDate.toISOString(),
    digest,
    condition_data: buildConditionData(namespace),
    access_aux_data: buildAccessAuxData({
      proof,
      signature,
    }),
    signature,
    proof: {
      vault_uuid: vaultUuid,
      caller: proof.caller,
      access_ref: proof.accessRef,
      scope,
      expiry: expiryDate.toISOString(),
      namespace,
    },
  }
}

export async function issueStoryAssetAccessProofViaDirectKey(input: {
  env: Env
  asset: Asset
  userId: string
  walletAttachmentId: string
  callerAddress: string
  decisionReason: "creator" | "moderator" | "purchase_entitlement"
  deliveryRef: string
}): Promise<AssetAccessProofResponse> {
  const privateKey = requirePrivateKey(
    input.env.STORY_ACCESS_CONTROLLER_PRIVATE_KEY,
    "story_access_controller_private_key",
  )
  const defaults = getStoryAeneidDeliveryDefaults()
  const rpcUrl = maybe(input.env.STORY_AENEID_RPC_URL) || defaults.rpcUrl
  if (!rpcUrl) {
    throw new Error("story_aeneid_rpc_url_missing")
  }
  const verifierContract = requireAddress(
    maybe(input.env.STORY_SIGNED_ACCESS_CONDITION_ADDRESS) || defaults.signedAccessConditionV1,
    "story_signed_access_condition_address",
  )
  const account = privateKeyToAccount(privateKey)
  const signerAddress = account.address.toLowerCase()
  const namespace = requireBytes32(input.asset.story_namespace, "story_namespace")
  const vaultUuid = Number(input.asset.story_cdr_vault_uuid ?? 0)
  if (!Number.isInteger(vaultUuid) || vaultUuid <= 0) {
    throw new Error("story_cdr_vault_uuid_missing")
  }

  const scope: AccessScope = input.decisionReason === "purchase_entitlement" ? "asset.share" : "asset.owner"
  const expirySeconds = parsePositiveInt(input.env.STORY_ACCESS_PROOF_TTL_SECONDS, DEFAULT_ACCESS_PROOF_TTL_SECONDS)
  const expiryDate = new Date(Date.now() + (expirySeconds * 1000))
  const proof: AccessProofRecord = {
    vaultUuid,
    caller: requireAddress(input.callerAddress, "caller_address"),
    accessRef: buildAccessRef({
      asset: input.asset,
      userId: input.userId,
      walletAttachmentId: input.walletAttachmentId,
      scope,
    }),
    scope,
    expiry: BigInt(Math.floor(expiryDate.getTime() / 1000)),
    namespace,
  }
  const digest = requireBytes32(String(await rpcRequest({
    rpcUrl,
    method: "eth_call",
    params: [
      {
        to: verifierContract,
        data: buildHashProofCalldata(proof),
      },
      "latest",
    ],
  }) || ""), "access_proof_digest")
  const signature = requireHexBytes(await account.sign({ hash: digest as `0x${string}` }), "signature")

  return {
    asset_id: input.asset.asset_id,
    community_id: input.asset.community_id,
    access_mode: "locked",
    decision_reason: input.decisionReason,
    delivery_ref: input.deliveryRef,
    wallet_attachment_id: input.walletAttachmentId,
    caller_address: proof.caller,
    signer_family: "story-access-controller",
    signer_address: signerAddress,
    verifier_contract: verifierContract,
    vault_uuid: vaultUuid,
    namespace,
    access_ref: proof.accessRef,
    scope,
    expiry: expiryDate.toISOString(),
    digest,
    condition_data: buildConditionData(namespace),
    access_aux_data: buildAccessAuxData({
      proof,
      signature,
    }),
    signature,
    proof: {
      vault_uuid: vaultUuid,
      caller: proof.caller,
      access_ref: proof.accessRef,
      scope,
      expiry: expiryDate.toISOString(),
      namespace,
    },
  }
}
