import { providerUnavailable, verificationRequired } from "../errors"
import type { Env } from "../../env"
import {
  inspectHnsRoot,
  observeHnsRootParent,
  publishHnsChallenge,
} from "./hns-verifier"
import {
  buildHnsImportPublishPlan,
  type HnsImportChallengePayload,
} from "./hns-import-plan"
import {
  HNS_VERIFIER_OBSERVATION_PROVIDER,
} from "./namespace-observation-provider"
import {
  deriveHnsInspectionSnapshot,
  isHnsVerifierConfigured,
  serializeSetupNameservers,
  type HnsSessionAssertionSnapshot,
} from "./verification-shared"

export type PreparedHnsImportChallenge = {
  anchorBlockHash: string
  anchorHeight: number
  challengePayload: HnsImportChallengePayload
  inspectionSnapshot: HnsSessionAssertionSnapshot
  observationProvider: string
  setupNameservers: string | null
}

/**
 * Prepares one complete owner-signed Handshake UPDATE. This is the sole
 * provisioning pipeline used by both session start and restart; callers only
 * differ in lock acquisition and INSERT-vs-UPDATE persistence.
 */
export async function prepareHnsImportChallenge(
  env: Env,
  input: {
    challengeTxtValue: string
    rootLabel: string
  },
): Promise<PreparedHnsImportChallenge> {
  if (!isHnsVerifierConfigured(env)) {
    throw providerUnavailable("HNS verifier is not configured")
  }

  const inspection = await inspectHnsRoot(env, { rootLabel: input.rootLabel })
  if (inspection.root_exists !== true) {
    throw verificationRequired("Handshake root does not exist on chain")
  }
  if (inspection.expiry_horizon_sufficient !== true) {
    throw verificationRequired("Handshake root must be renewed before import")
  }

  // Validate the parent response (including raw_records) before mutating the
  // managed zone. A verifier contract error therefore leaves the session row
  // and its published challenge untouched.
  const parentObservation = await observeHnsRootParent(env, {
    rootLabel: input.rootLabel,
  })
  const provisioned = await publishHnsChallenge(env, {
    rootLabel: input.rootLabel,
    challengeTxtValue: input.challengeTxtValue,
  })
  const nameservers = provisioned.nameservers?.map((entry) => entry.trim()).filter(Boolean) ?? []
  const publishPlan = buildHnsImportPublishPlan({
    currentRecords: parentObservation.parent.raw_records,
    nameservers,
    challengeTxtValue: input.challengeTxtValue,
    dsRecords: provisioned.ds_records ?? [],
  })

  return {
    anchorBlockHash: parentObservation.chain_anchor.block_hash,
    anchorHeight: parentObservation.chain_anchor.height,
    challengePayload: {
      kind: "hns_import",
      publish_plan: publishPlan,
      observed_chain_anchor: parentObservation.chain_anchor,
    },
    inspectionSnapshot: deriveHnsInspectionSnapshot(inspection),
    observationProvider: inspection.observation_provider ?? HNS_VERIFIER_OBSERVATION_PROVIDER,
    setupNameservers: serializeSetupNameservers(nameservers),
  }
}
