import { describe, expect, test } from "bun:test";
import { runIssuerOnce } from "./runtime.js";

const baseEnv = {
  COMMUNITY_PROTOCOL_ISSUER_COMMUNITY_DB_URL: "file:/tmp/community-protocol-runtime-test.db",
  COMMUNITY_PROTOCOL_ISSUER_SUBSD_BASE_URL: "http://127.0.0.1:7226",
  COMMUNITY_PROTOCOL_ISSUER_RUNPOD_ENDPOINT_ID: "endpoint-test",
  COMMUNITY_PROTOCOL_ISSUER_RUNPOD_API_KEY: "key-test",
};

describe("issuer runtime", () => {
  test("refuses RunPod proof jobs with memory artifact storage", async () => {
    await expect(runIssuerOnce({
      env: {
        ...baseEnv,
        COMMUNITY_PROTOCOL_ISSUER_PROOF_ARTIFACT_STORE: "memory",
      },
    })).rejects.toThrow("RunPod proof jobs require durable file artifact storage");
  });

  test("requires an artifact directory for file artifact storage", async () => {
    await expect(runIssuerOnce({
      env: {
        ...baseEnv,
        COMMUNITY_PROTOCOL_ISSUER_PROOF_ARTIFACT_STORE: "file",
      },
    })).rejects.toThrow("COMMUNITY_PROTOCOL_ISSUER_PROOF_ARTIFACT_DIR is required for file artifact storage");
  });
});
