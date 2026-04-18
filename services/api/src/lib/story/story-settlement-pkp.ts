import { getAddress } from "ethers"
import type { Env } from "../../types"
import type { ConfigResult } from "../config-result"
import {
  assertPkpPublicKeyMatchesAddress,
  parseChipotleBaseUrl,
  parseIpfsGatewayUrl,
  parseLitActionCid,
  parseOptionalPkpPublicKey,
  type PkpExecutionConfig,
} from "../evm-chipotle"
import { parseExpectedEvmAddress } from "../evm-signer"

export const STORY_SETTLEMENT_ACTION = {
  SETTLE: "settle",
  ROYALTY_SYNC: "royaltySync",
} as const

export type StorySettlementAction = typeof STORY_SETTLEMENT_ACTION[keyof typeof STORY_SETTLEMENT_ACTION]

export type StorySettlementPkpExecutionConfig = {
  pkp: PkpExecutionConfig
  actions: Partial<Record<StorySettlementAction, `ipfs://${string}`>>
}

function parseOptionalPkpId(value: string | null | undefined): ConfigResult<string | null> {
  const normalized = String(value || "").trim()
  if (!normalized) return { ok: true, value: null }
  const parsed = parseExpectedEvmAddress(normalized)
  if (!parsed) {
    return { ok: false, error: "MUSIC_PURCHASE_STORY_SETTLEMENT_PKP_ID missing/invalid" }
  }
  return { ok: true, value: getAddress(parsed) }
}

const ACTION_ENV_FIELDS: Record<StorySettlementAction, string> = {
  [STORY_SETTLEMENT_ACTION.SETTLE]: "STORY_SETTLEMENT_ACTION_CID_SETTLE",
  [STORY_SETTLEMENT_ACTION.ROYALTY_SYNC]: "STORY_SETTLEMENT_ACTION_CID_ROYALTY_SYNC",
}

export function resolveStorySettlementPkpExecutionConfig(
  env: Env,
): ConfigResult<StorySettlementPkpExecutionConfig | null> {
  const rawActionValues = Object.values(ACTION_ENV_FIELDS).map((field) => String(env[field as keyof Env] || "").trim())
  const hasAnyConfig = Boolean(
    String(env.MUSIC_PURCHASE_STORY_SETTLEMENT_PKP_ADDRESS || "").trim()
    || String(env.MUSIC_PURCHASE_STORY_SETTLEMENT_PKP_ID || "").trim()
    || String(env.MUSIC_PURCHASE_STORY_SETTLEMENT_PKP_PUBLIC_KEY || "").trim()
    || String(env.LIT_CHIPOTLE_STORY_SETTLEMENT_API_KEY || "").trim()
    || rawActionValues.some((value) => value.length > 0),
  )
  if (!hasAnyConfig) {
    return { ok: true, value: null }
  }

  const pkpAddress = parseExpectedEvmAddress(env.MUSIC_PURCHASE_STORY_SETTLEMENT_PKP_ADDRESS)
  if (!pkpAddress) {
    return { ok: false, error: "MUSIC_PURCHASE_STORY_SETTLEMENT_PKP_ADDRESS missing/invalid" }
  }
  const pkpId = parseOptionalPkpId(env.MUSIC_PURCHASE_STORY_SETTLEMENT_PKP_ID)
  if (!pkpId.ok) return pkpId
  const pkpPublicKey = parseOptionalPkpPublicKey(
    env.MUSIC_PURCHASE_STORY_SETTLEMENT_PKP_PUBLIC_KEY,
    "MUSIC_PURCHASE_STORY_SETTLEMENT_PKP_PUBLIC_KEY",
  )
  if (!pkpPublicKey.ok) return pkpPublicKey
  const pkpPublicKeyMatches = assertPkpPublicKeyMatchesAddress({
    pkpAddress,
    pkpPublicKey: pkpPublicKey.value,
    addressField: "MUSIC_PURCHASE_STORY_SETTLEMENT_PKP_ADDRESS",
    publicKeyField: "MUSIC_PURCHASE_STORY_SETTLEMENT_PKP_PUBLIC_KEY",
  })
  if (!pkpPublicKeyMatches.ok) return pkpPublicKeyMatches

  const apiKey = String(env.LIT_CHIPOTLE_STORY_SETTLEMENT_API_KEY || "").trim()
  if (!apiKey) {
    return { ok: false, error: "Missing LIT_CHIPOTLE_STORY_SETTLEMENT_API_KEY" }
  }

  const chipotleBaseUrl = parseChipotleBaseUrl(env.LIT_CHIPOTLE_API_BASE_URL)
  if (!chipotleBaseUrl.ok) return chipotleBaseUrl
  const ipfsGatewayUrl = parseIpfsGatewayUrl(env.IPFS_GATEWAY_URL)
  if (!ipfsGatewayUrl.ok) return ipfsGatewayUrl

  const actions: Partial<Record<StorySettlementAction, `ipfs://${string}`>> = {}
  for (const [action, fieldName] of Object.entries(ACTION_ENV_FIELDS) as Array<[StorySettlementAction, string]>) {
    const raw = String(env[fieldName as keyof Env] || "").trim()
    if (!raw) continue
    const parsed = parseLitActionCid(raw, fieldName)
    if (!parsed.ok) return parsed
    actions[action] = parsed.value
  }
  if (Object.keys(actions).length === 0) {
    return { ok: false, error: "Missing STORY_SETTLEMENT_ACTION_CID_* configuration" }
  }

  return {
    ok: true,
    value: {
      pkp: {
        pkpAddress: getAddress(pkpAddress) as `0x${string}`,
        pkpId: pkpId.value,
        pkpPublicKey: pkpPublicKey.value,
        apiKey,
        baseUrl: chipotleBaseUrl.value,
        ipfsGatewayUrl: ipfsGatewayUrl.value,
        actionCid: actions[STORY_SETTLEMENT_ACTION.SETTLE] || Object.values(actions)[0]!,
      },
      actions,
    },
  }
}

export function resolveStorySettlementPkpAction(
  config: StorySettlementPkpExecutionConfig | null,
  action: StorySettlementAction,
): PkpExecutionConfig | null {
  if (!config) return null
  const actionCid = config.actions[action]
  if (!actionCid) return null
  return {
    ...config.pkp,
    actionCid,
  }
}
