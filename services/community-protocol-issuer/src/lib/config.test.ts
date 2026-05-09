import { describe, expect, test } from "bun:test";
import { readIssuerRuntimeConfig } from "./config.js";

const baseEnv = {
  COMMUNITY_PROTOCOL_ISSUER_COMMUNITY_DB_URL: "file:/tmp/community.db",
  COMMUNITY_PROTOCOL_ISSUER_SUBSD_BASE_URL: "http://127.0.0.1:7226",
};

describe("issuer runtime config", () => {
  test("reads required env with pilot-safe defaults", () => {
    expect(readIssuerRuntimeConfig(baseEnv)).toEqual({
      communityDbUrl: "file:/tmp/community.db",
      communityDbAuthToken: null,
      communityId: null,
      controlPlaneDatabaseUrl: null,
      tursoCommunityDbWrapKey: null,
      subsdBaseUrl: "http://127.0.0.1:7226",
      runpodEndpointId: null,
      runpodApiKey: null,
      proofArtifactStore: null,
      proofArtifactDir: null,
      minBatchSize: 5,
      maxBatchSize: 50,
      maxBatchAgeSeconds: 1800,
      btcFeeRateSatVb: undefined,
      proofJobMaxAgeSeconds: undefined,
      scanLimit: undefined,
    });
  });

  test("reads control-plane community DB resolver settings", () => {
    expect(readIssuerRuntimeConfig({
      COMMUNITY_PROTOCOL_ISSUER_COMMUNITY_ID: "cmt_test",
      CONTROL_PLANE_DATABASE_URL: "postgresql://control.example/pirate",
      TURSO_COMMUNITY_DB_WRAP_KEY: "11".repeat(32),
      COMMUNITY_PROTOCOL_ISSUER_SUBSD_BASE_URL: "http://127.0.0.1:7226",
    })).toMatchObject({
      communityDbUrl: null,
      communityDbAuthToken: null,
      communityId: "cmt_test",
      controlPlaneDatabaseUrl: "postgresql://control.example/pirate",
      tursoCommunityDbWrapKey: "11".repeat(32),
    });
  });

  test("reads optional Bitcoin broadcast fee rate", () => {
    expect(readIssuerRuntimeConfig({
      ...baseEnv,
      COMMUNITY_PROTOCOL_ISSUER_BTC_FEE_RATE_SAT_VB: "2",
    }).btcFeeRateSatVb).toBe(2);
  });

  test("reads optional RunPod proof settings", () => {
    expect(readIssuerRuntimeConfig({
      ...baseEnv,
      COMMUNITY_PROTOCOL_ISSUER_RUNPOD_ENDPOINT_ID: "endpoint-test",
      COMMUNITY_PROTOCOL_ISSUER_RUNPOD_API_KEY: "key-test",
      COMMUNITY_PROTOCOL_ISSUER_PROOF_ARTIFACT_STORE: "file",
      COMMUNITY_PROTOCOL_ISSUER_PROOF_ARTIFACT_DIR: "/tmp/proofs",
      COMMUNITY_PROTOCOL_ISSUER_PROOF_JOB_MAX_AGE_SECONDS: "3600",
    })).toMatchObject({
      runpodEndpointId: "endpoint-test",
      runpodApiKey: "key-test",
      proofArtifactStore: "file",
      proofArtifactDir: "/tmp/proofs",
      proofJobMaxAgeSeconds: 3600,
    });
  });

  test("rejects invalid batch thresholds", () => {
    expect(() => readIssuerRuntimeConfig({
      ...baseEnv,
      COMMUNITY_PROTOCOL_ISSUER_MIN_BATCH_SIZE: "10",
      COMMUNITY_PROTOCOL_ISSUER_MAX_BATCH_SIZE: "5",
    })).toThrow("COMMUNITY_PROTOCOL_ISSUER_MIN_BATCH_SIZE must be <= COMMUNITY_PROTOCOL_ISSUER_MAX_BATCH_SIZE");
  });

  test("requires community DB and subsd base URL", () => {
    expect(() => readIssuerRuntimeConfig({
      COMMUNITY_PROTOCOL_ISSUER_SUBSD_BASE_URL: "http://127.0.0.1:7226",
    })).toThrow("Either COMMUNITY_PROTOCOL_ISSUER_COMMUNITY_DB_URL or COMMUNITY_PROTOCOL_ISSUER_COMMUNITY_ID is required");
    expect(() => readIssuerRuntimeConfig({
      COMMUNITY_PROTOCOL_ISSUER_COMMUNITY_DB_URL: "file:/tmp/community.db",
    })).toThrow("COMMUNITY_PROTOCOL_ISSUER_SUBSD_BASE_URL is required");
  });
});
