import type { Env } from "../../env"
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

export type StoryAccessControllerPkpExecutionConfig = {
  pkp: PkpExecutionConfig
}

export function resolveStoryAccessControllerPkpExecutionConfig(
  env: Pick<
    Env,
    | "STORY_ACCESS_CONTROLLER_PKP_ADDRESS"
    | "STORY_ACCESS_CONTROLLER_PKP_PUBLIC_KEY"
    | "STORY_ACCESS_CONTROLLER_ACTION_CID_SIGN_ACCESS_PROOF"
    | "LIT_CHIPOTLE_ACCESS_CONTROLLER_API_KEY"
    | "LIT_CHIPOTLE_API_BASE_URL"
    | "IPFS_GATEWAY_URL"
  >,
): ConfigResult<StoryAccessControllerPkpExecutionConfig | null> {
  const hasAnyConfig = Boolean(
    String(env.STORY_ACCESS_CONTROLLER_PKP_ADDRESS || "").trim()
    || String(env.STORY_ACCESS_CONTROLLER_PKP_PUBLIC_KEY || "").trim()
    || String(env.STORY_ACCESS_CONTROLLER_ACTION_CID_SIGN_ACCESS_PROOF || "").trim()
    || String(env.LIT_CHIPOTLE_ACCESS_CONTROLLER_API_KEY || "").trim(),
  )
  if (!hasAnyConfig) {
    return { ok: true, value: null }
  }

  const pkpAddress = parseExpectedEvmAddress(env.STORY_ACCESS_CONTROLLER_PKP_ADDRESS)
  if (!pkpAddress) {
    return { ok: false, error: "STORY_ACCESS_CONTROLLER_PKP_ADDRESS missing/invalid" }
  }
  const pkpPublicKey = parseOptionalPkpPublicKey(
    env.STORY_ACCESS_CONTROLLER_PKP_PUBLIC_KEY,
    "STORY_ACCESS_CONTROLLER_PKP_PUBLIC_KEY",
  )
  if (!pkpPublicKey.ok) return pkpPublicKey
  const pkpMatch = assertPkpPublicKeyMatchesAddress({
    pkpAddress,
    pkpPublicKey: pkpPublicKey.value,
    addressField: "STORY_ACCESS_CONTROLLER_PKP_ADDRESS",
    publicKeyField: "STORY_ACCESS_CONTROLLER_PKP_PUBLIC_KEY",
  })
  if (!pkpMatch.ok) return pkpMatch

  const actionCid = parseLitActionCid(
    env.STORY_ACCESS_CONTROLLER_ACTION_CID_SIGN_ACCESS_PROOF,
    "STORY_ACCESS_CONTROLLER_ACTION_CID_SIGN_ACCESS_PROOF",
  )
  if (!actionCid.ok) return actionCid

  const apiKey = String(env.LIT_CHIPOTLE_ACCESS_CONTROLLER_API_KEY || "").trim()
  if (!apiKey) {
    return { ok: false, error: "Missing LIT_CHIPOTLE_ACCESS_CONTROLLER_API_KEY" }
  }

  const chipotleBaseUrl = parseChipotleBaseUrl(env.LIT_CHIPOTLE_API_BASE_URL)
  if (!chipotleBaseUrl.ok) return chipotleBaseUrl
  const ipfsGatewayUrl = parseIpfsGatewayUrl(env.IPFS_GATEWAY_URL)
  if (!ipfsGatewayUrl.ok) return ipfsGatewayUrl

  return {
    ok: true,
    value: {
      pkp: {
        pkpAddress: pkpAddress as `0x${string}`,
        pkpPublicKey: pkpPublicKey.value,
        apiKey,
        baseUrl: chipotleBaseUrl.value,
        ipfsGatewayUrl: ipfsGatewayUrl.value,
        actionCid: actionCid.value,
      },
    },
  }
}
