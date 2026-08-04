import type { ShardLoadSnapshotRequest } from "@pirate/api-shared"
import type { Env } from "../../../env"
import { COMMUNITY_SCHEMA_OBSERVATION_PROOF } from "./generated/community-schema-snapshot"

export function provisioningSchemaAttestation(
  env: Pick<Env, "COMMUNITY_SCHEMA_POLICY_DIGEST">,
): ShardLoadSnapshotRequest["attestation"] | undefined {
  const effectivePolicyDigest = String(env.COMMUNITY_SCHEMA_POLICY_DIGEST ?? "").trim()
  if (!/^[0-9a-f]{64}$/u.test(effectivePolicyDigest)) return undefined
  return {
    effectivePolicyDigest,
    expectedObservationProof: COMMUNITY_SCHEMA_OBSERVATION_PROOF,
  }
}
