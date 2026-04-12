import { readFileSync } from "node:fs"

type StoryAeneidDeliveryConfig = {
  network?: {
    deployRpcUrl?: string
  }
  contracts?: {
    songIpTokenV1?: string
    purchaseEntitlementToken?: string
    pirateSignerRegistry?: string
    tokenGateCondition?: string
    signedAccessConditionV1?: string
    assetPublishCoordinatorV1?: string
    marketplaceSettlementV1?: string
  }
  grants?: {
    publishOperator?: string
    settlementOperator?: string
    accessProofSigner?: string
  }
}

let cachedConfig: StoryAeneidDeliveryConfig | null = null

const CONFIG_CANDIDATES = [
  new URL("../../../../../config/story-aeneid-delivery.json", import.meta.url),
  new URL("../../../../../../config/story-aeneid-delivery.json", import.meta.url),
]

function readConfig(): StoryAeneidDeliveryConfig {
  if (cachedConfig) {
    return cachedConfig
  }

  let lastError: Error | null = null
  for (const candidate of CONFIG_CANDIDATES) {
    try {
      const raw = readFileSync(candidate, "utf8")
      cachedConfig = JSON.parse(raw) as StoryAeneidDeliveryConfig
      return cachedConfig
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  throw lastError ?? new Error("story_delivery_config_missing")
}

export function getStoryAeneidDeliveryDefaults(): {
  rpcUrl: string | null
  songIpTokenV1: string | null
  purchaseEntitlementToken: string | null
  pirateSignerRegistry: string | null
  tokenGateCondition: string | null
  signedAccessConditionV1: string | null
  assetPublishCoordinatorV1: string | null
  marketplaceSettlementV1: string | null
  publishOperator: string | null
  settlementOperator: string | null
  accessProofSigner: string | null
} {
  const config = readConfig()
  return {
    rpcUrl: typeof config.network?.deployRpcUrl === "string" ? config.network.deployRpcUrl : null,
    songIpTokenV1: typeof config.contracts?.songIpTokenV1 === "string" ? config.contracts.songIpTokenV1 : null,
    purchaseEntitlementToken: typeof config.contracts?.purchaseEntitlementToken === "string" ? config.contracts.purchaseEntitlementToken : null,
    pirateSignerRegistry: typeof config.contracts?.pirateSignerRegistry === "string" ? config.contracts.pirateSignerRegistry : null,
    tokenGateCondition: typeof config.contracts?.tokenGateCondition === "string" ? config.contracts.tokenGateCondition : null,
    signedAccessConditionV1: typeof config.contracts?.signedAccessConditionV1 === "string" ? config.contracts.signedAccessConditionV1 : null,
    assetPublishCoordinatorV1: typeof config.contracts?.assetPublishCoordinatorV1 === "string" ? config.contracts.assetPublishCoordinatorV1 : null,
    marketplaceSettlementV1: typeof config.contracts?.marketplaceSettlementV1 === "string" ? config.contracts.marketplaceSettlementV1 : null,
    publishOperator: typeof config.grants?.publishOperator === "string" ? config.grants.publishOperator : null,
    settlementOperator: typeof config.grants?.settlementOperator === "string" ? config.grants.settlementOperator : null,
    accessProofSigner: typeof config.grants?.accessProofSigner === "string" ? config.grants.accessProofSigner : null,
  }
}
