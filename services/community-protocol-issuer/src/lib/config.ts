import type { IssuerWorkflowConfig } from "./issuer-workflow.js";
import { requireText, trim } from "@pirate/api-shared";

export type IssuerRuntimeConfig = IssuerWorkflowConfig & {
  communityDbUrl: string | null;
  communityDbAuthToken: string | null;
  communityId: string | null;
  controlPlaneDatabaseUrl: string | null;
  tursoCommunityDbWrapKey: string | null;
  subsdBaseUrl: string;
  runpodEndpointId: string | null;
  runpodApiKey: string | null;
  proofArtifactStore: "file" | "memory" | null;
  proofArtifactDir: string | null;
};

function readRequiredString(env: Record<string, string | undefined>, key: string): string {
  return requireText(env[key], key);
}

function readOptionalString(env: Record<string, string | undefined>, key: string): string | null {
  const value = trim(env[key]);
  return value || null;
}

function readPositiveInt(
  env: Record<string, string | undefined>,
  key: string,
  defaultValue: number,
): number {
  const raw = trim(env[key]);
  if (!raw) {
    return defaultValue;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

function readOptionalPositiveInt(env: Record<string, string | undefined>, key: string): number | undefined {
  const raw = trim(env[key]);
  if (!raw) {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

function readProofArtifactStore(env: Record<string, string | undefined>): "file" | "memory" | null {
  const value = readOptionalString(env, "COMMUNITY_PROTOCOL_ISSUER_PROOF_ARTIFACT_STORE");
  if (!value) {
    return null;
  }
  if (value === "file" || value === "memory") {
    return value;
  }
  throw new Error("COMMUNITY_PROTOCOL_ISSUER_PROOF_ARTIFACT_STORE must be one of: file, memory");
}

export function readIssuerRuntimeConfig(env: Record<string, string | undefined>): IssuerRuntimeConfig {
  const minBatchSize = readPositiveInt(env, "COMMUNITY_PROTOCOL_ISSUER_MIN_BATCH_SIZE", 5);
  const maxBatchSize = readPositiveInt(env, "COMMUNITY_PROTOCOL_ISSUER_MAX_BATCH_SIZE", 50);
  if (minBatchSize > maxBatchSize) {
    throw new Error("COMMUNITY_PROTOCOL_ISSUER_MIN_BATCH_SIZE must be <= COMMUNITY_PROTOCOL_ISSUER_MAX_BATCH_SIZE");
  }
  const communityDbUrl = readOptionalString(env, "COMMUNITY_PROTOCOL_ISSUER_COMMUNITY_DB_URL");
  const communityId = readOptionalString(env, "COMMUNITY_PROTOCOL_ISSUER_COMMUNITY_ID");
  if (!communityDbUrl && !communityId) {
    throw new Error("Either COMMUNITY_PROTOCOL_ISSUER_COMMUNITY_DB_URL or COMMUNITY_PROTOCOL_ISSUER_COMMUNITY_ID is required");
  }

  return {
    communityDbUrl,
    communityDbAuthToken: readOptionalString(env, "COMMUNITY_PROTOCOL_ISSUER_COMMUNITY_DB_AUTH_TOKEN"),
    communityId,
    controlPlaneDatabaseUrl: readOptionalString(env, "CONTROL_PLANE_DATABASE_URL"),
    tursoCommunityDbWrapKey: readOptionalString(env, "TURSO_COMMUNITY_DB_WRAP_KEY"),
    subsdBaseUrl: readRequiredString(env, "COMMUNITY_PROTOCOL_ISSUER_SUBSD_BASE_URL"),
    runpodEndpointId: readOptionalString(env, "COMMUNITY_PROTOCOL_ISSUER_RUNPOD_ENDPOINT_ID"),
    runpodApiKey: readOptionalString(env, "COMMUNITY_PROTOCOL_ISSUER_RUNPOD_API_KEY"),
    proofArtifactStore: readProofArtifactStore(env),
    proofArtifactDir: readOptionalString(env, "COMMUNITY_PROTOCOL_ISSUER_PROOF_ARTIFACT_DIR"),
    minBatchSize,
    maxBatchSize,
    maxBatchAgeSeconds: readPositiveInt(env, "COMMUNITY_PROTOCOL_ISSUER_MAX_BATCH_AGE_SECONDS", 30 * 60),
    btcFeeRateSatVb: readOptionalPositiveInt(env, "COMMUNITY_PROTOCOL_ISSUER_BTC_FEE_RATE_SAT_VB"),
    proofJobMaxAgeSeconds: readOptionalPositiveInt(env, "COMMUNITY_PROTOCOL_ISSUER_PROOF_JOB_MAX_AGE_SECONDS"),
    scanLimit: readOptionalPositiveInt(env, "COMMUNITY_PROTOCOL_ISSUER_SCAN_LIMIT"),
  };
}
