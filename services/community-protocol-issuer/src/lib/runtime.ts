import { readIssuerRuntimeConfig } from "./config.js";
import { runIssuerWorkflow, type IssuerWorkflowResult } from "./issuer-workflow.js";
import { openLibsqlProtocolIssuanceStore } from "./libsql-store.js";
import { FileProofArtifactStore, MemoryProofArtifactStore } from "./proof-artifact-store.js";
import { createRunPodProofClient } from "./runpod-proof-client.js";
import { createSubsdHttpClient } from "./subsd-client.js";

export async function runIssuerOnce(input: {
  env: Record<string, string | undefined>;
  now?: Date;
}): Promise<IssuerWorkflowResult> {
  const config = readIssuerRuntimeConfig(input.env);
  const runpodConfigured = Boolean(config.runpodEndpointId || config.runpodApiKey);
  if (runpodConfigured && (!config.runpodEndpointId || !config.runpodApiKey)) {
    throw new Error("Both COMMUNITY_PROTOCOL_ISSUER_RUNPOD_ENDPOINT_ID and COMMUNITY_PROTOCOL_ISSUER_RUNPOD_API_KEY are required for proof jobs");
  }
  if (runpodConfigured && !config.proofArtifactStore) {
    throw new Error("COMMUNITY_PROTOCOL_ISSUER_PROOF_ARTIFACT_STORE is required when RunPod proof jobs are enabled");
  }
  if (runpodConfigured && config.proofArtifactStore !== "file") {
    throw new Error("RunPod proof jobs require durable file artifact storage");
  }
  if (config.proofArtifactStore === "file" && !config.proofArtifactDir) {
    throw new Error("COMMUNITY_PROTOCOL_ISSUER_PROOF_ARTIFACT_DIR is required for file artifact storage");
  }
  const artifactStore = config.proofArtifactStore === "file" && config.proofArtifactDir
    ? new FileProofArtifactStore(config.proofArtifactDir)
    : config.proofArtifactStore === "memory"
      ? new MemoryProofArtifactStore()
      : undefined;
  const proofClient = config.runpodEndpointId && config.runpodApiKey
    ? createRunPodProofClient({
      endpointId: config.runpodEndpointId,
      apiKey: config.runpodApiKey,
    })
    : undefined;
  const opened = await openLibsqlProtocolIssuanceStore({
    url: config.communityDbUrl,
    authToken: config.communityDbAuthToken,
  });
  try {
    return await runIssuerWorkflow({
      store: opened.store,
      subsd: createSubsdHttpClient({ baseUrl: config.subsdBaseUrl }),
      proofClient,
      artifactStore,
      config,
      now: input.now,
    });
  } finally {
    opened.close();
  }
}
