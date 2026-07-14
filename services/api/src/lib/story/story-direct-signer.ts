import { Wallet, getAddress } from "ethers"
import type { Env } from "../../env"
import type { ConfigResult } from "../config-result"
import { assertPrivateKeyMatchesExpectedAddress, parseExpectedEvmAddress } from "../evm-signer"

export type StoryDirectSignerConfig = {
  privateKey: string
  address: `0x${string}`
}

export function normalizeDirectSignerPrivateKey(raw: string | null | undefined): string | null {
  const value = String(raw || "").trim()
  if (!value) return null
  const withPrefix = value.startsWith("0x") ? value : `0x${value}`
  return /^0x[a-fA-F0-9]{64}$/.test(withPrefix) ? withPrefix : null
}

function resolveStoryDirectSignerConfig(params: {
  privateKeyValue: string | null | undefined
  privateKeyField: string
  expectedAddressValue?: string | null | undefined
  expectedAddressField?: string
}): ConfigResult<StoryDirectSignerConfig | null> {
  const hasAnyConfig = Boolean(
    String(params.privateKeyValue || "").trim()
    || String(params.expectedAddressValue || "").trim(),
  )
  if (!hasAnyConfig) {
    return { ok: true, value: null }
  }

  const privateKey = normalizeDirectSignerPrivateKey(params.privateKeyValue)
  if (!privateKey) {
    return { ok: false, error: `${params.privateKeyField} missing/invalid` }
  }

  const expectedAddress = parseExpectedEvmAddress(params.expectedAddressValue)
  let address: string
  try {
    address = expectedAddress && params.expectedAddressField
      ? assertPrivateKeyMatchesExpectedAddress({
          privateKey,
          expectedAddress,
          expectedField: params.expectedAddressField,
        })
      : getAddress(new Wallet(privateKey).address)
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : `${params.privateKeyField} missing/invalid`,
    }
  }

  return {
    ok: true,
    value: {
      privateKey,
      address: getAddress(address) as `0x${string}`,
    },
  }
}

export function resolveStoryOperatorDirectSigner(env: Pick<Env, "STORY_OPERATOR_PRIVATE_KEY" | "STORY_OPERATOR_PKP_ADDRESS">): ConfigResult<StoryDirectSignerConfig | null> {
  return resolveStoryDirectSignerConfig({
    privateKeyValue: env.STORY_OPERATOR_PRIVATE_KEY,
    privateKeyField: "STORY_OPERATOR_PRIVATE_KEY",
    expectedAddressValue: env.STORY_OPERATOR_PKP_ADDRESS,
    expectedAddressField: "STORY_OPERATOR_PKP_ADDRESS",
  })
}

export function resolveStoryEntitlementClassConfigurerDirectSigner(
  env: Pick<
    Env,
    "STORY_ENTITLEMENT_CLASS_CONFIGURER_PRIVATE_KEY" | "STORY_ENTITLEMENT_CLASS_CONFIGURER_ADDRESS"
  >,
): ConfigResult<StoryDirectSignerConfig | null> {
  return resolveStoryDirectSignerConfig({
    privateKeyValue: env.STORY_ENTITLEMENT_CLASS_CONFIGURER_PRIVATE_KEY,
    privateKeyField: "STORY_ENTITLEMENT_CLASS_CONFIGURER_PRIVATE_KEY",
    expectedAddressValue: env.STORY_ENTITLEMENT_CLASS_CONFIGURER_ADDRESS,
    expectedAddressField: "STORY_ENTITLEMENT_CLASS_CONFIGURER_ADDRESS",
  })
}

export function resolveStoryCdrWriterDirectSigner(env: Pick<Env, "STORY_CDR_WRITER_PRIVATE_KEY" | "STORY_CDR_WRITER_PKP_ADDRESS">): ConfigResult<StoryDirectSignerConfig | null> {
  return resolveStoryDirectSignerConfig({
    privateKeyValue: env.STORY_CDR_WRITER_PRIVATE_KEY,
    privateKeyField: "STORY_CDR_WRITER_PRIVATE_KEY",
    expectedAddressValue: env.STORY_CDR_WRITER_PKP_ADDRESS,
    expectedAddressField: "STORY_CDR_WRITER_PKP_ADDRESS",
  })
}

export function resolveStoryAccessControllerDirectSigner(
  env: Pick<Env, "STORY_ACCESS_CONTROLLER_PRIVATE_KEY" | "STORY_ACCESS_CONTROLLER_PKP_ADDRESS">,
): ConfigResult<StoryDirectSignerConfig | null> {
  return resolveStoryDirectSignerConfig({
    privateKeyValue: env.STORY_ACCESS_CONTROLLER_PRIVATE_KEY,
    privateKeyField: "STORY_ACCESS_CONTROLLER_PRIVATE_KEY",
    expectedAddressValue: env.STORY_ACCESS_CONTROLLER_PKP_ADDRESS,
    expectedAddressField: "STORY_ACCESS_CONTROLLER_PKP_ADDRESS",
  })
}

export function resolveStorySettlementDirectSigner(
  env: Pick<Env, "MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY" | "MUSIC_PURCHASE_STORY_SETTLEMENT_PKP_ADDRESS">,
): ConfigResult<StoryDirectSignerConfig | null> {
  return resolveStoryDirectSignerConfig({
    privateKeyValue: env.MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY,
    privateKeyField: "MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY",
    expectedAddressValue: env.MUSIC_PURCHASE_STORY_SETTLEMENT_PKP_ADDRESS,
    expectedAddressField: "MUSIC_PURCHASE_STORY_SETTLEMENT_PKP_ADDRESS",
  })
}
