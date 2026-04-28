import type { Env } from "../../types"
import { isHnsVerifierConfigured } from "./hns-verifier"

export const HNS_VERIFIER_OBSERVATION_PROVIDER = "hns_verifier"
export const LOCAL_DEV_HNS_OBSERVATION_PROVIDER = "local_dev_hns_verifier"

export function resolveHnsObservationProviderFallback(env: Env): string {
  return isHnsVerifierConfigured(env)
    ? HNS_VERIFIER_OBSERVATION_PROVIDER
    : LOCAL_DEV_HNS_OBSERVATION_PROVIDER
}

export function isLocalDevHnsObservationProvider(provider: string | null | undefined): boolean {
  return provider === LOCAL_DEV_HNS_OBSERVATION_PROVIDER
}
