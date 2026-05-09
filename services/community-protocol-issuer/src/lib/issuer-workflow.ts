import { makeIssuerId } from "./ids.js";
import type {
  BatchWithIssuances,
  MarkIssuanceIssuedInput,
  PendingProtocolIssuance,
  ProtocolIssuanceStore,
} from "./types.js";
import type { ProofArtifactStore } from "./proof-artifact-store.js";
import type { ProofJobClient } from "./runpod-proof-client.js";
import type { SubsdCertificateResult, SubsdClient, SubsdStageResult } from "./subsd-client.js";

export type IssuerWorkflowConfig = {
  minBatchSize: number;
  maxBatchSize: number;
  maxBatchAgeSeconds: number;
  btcFeeRateSatVb?: number;
  proofJobMaxAgeSeconds?: number;
  maxProofJobsPerBatch?: number;
  scanLimit?: number;
};

export type IssuerWorkflowResult = {
  staged: number;
  batchesCreated: number;
  batchesCommitted: number;
  batchesNeedingProof: number;
  batchesProofSubmitted: number;
  batchesProofCompleted: number;
  batchesBroadcast: number;
  batchesPublished: number;
  failed: number;
};

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function isOlderThan(input: {
  timestamp: string | null;
  now: string;
  maxAgeSeconds: number | undefined;
}): boolean {
  if (!input.timestamp || input.maxAgeSeconds === undefined) {
    return false;
  }
  return Date.parse(input.timestamp) <= Date.parse(input.now) - input.maxAgeSeconds * 1000;
}

function maxProofJobsPerBatch(configured: number | undefined): number {
  return configured ?? 16;
}

async function failBatchForProofJobLimit(input: {
  store: ProtocolIssuanceStore;
  batch: BatchWithIssuances;
  maxProofJobs: number;
  now: string;
}): Promise<void> {
  await input.store.markBatchFailed({
    batchId: input.batch.batch.id,
    errorCode: "proof_job_limit_exceeded",
    errorMessage: `Protocol issuance batch exceeded max proof jobs (${input.maxProofJobs})`,
    now: input.now,
  });
}

function groupByParentSpace(issuances: PendingProtocolIssuance[]): Map<string, PendingProtocolIssuance[]> {
  const grouped = new Map<string, PendingProtocolIssuance[]>();
  for (const issuance of issuances) {
    const current = grouped.get(issuance.parentSpace) ?? [];
    current.push(issuance);
    grouped.set(issuance.parentSpace, current);
  }
  return grouped;
}

function isIdempotentStageSuccess(result: SubsdStageResult): boolean {
  return result.status === "staged" || result.status === "already_staged" || result.status === "already_committed";
}

async function stageIssuances(input: {
  subsd: SubsdClient;
  issuances: PendingProtocolIssuance[];
}): Promise<{
  staged: PendingProtocolIssuance[];
  failed: Array<{ issuance: PendingProtocolIssuance; errorMessage: string }>;
  retryable: Array<{ issuance: PendingProtocolIssuance; errorMessage: string }>;
}> {
  const staged: PendingProtocolIssuance[] = [];
  const failed: Array<{ issuance: PendingProtocolIssuance; errorMessage: string }> = [];
  const retryable: Array<{ issuance: PendingProtocolIssuance; errorMessage: string }> = [];
  for (const issuance of input.issuances) {
    let result: SubsdStageResult;
    try {
      result = await input.subsd.stageRequest({
        parentSpace: issuance.parentSpace,
        sname: issuance.sname,
        scriptPubkeyHex: issuance.scriptPubkeyHex,
      });
    } catch (error) {
      retryable.push({
        issuance,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (isIdempotentStageSuccess(result)) {
      staged.push(issuance);
    } else {
      const reason = result.status === "script_pubkey_conflict" ? result.reason : result.status;
      failed.push({
        issuance,
        errorMessage: `subsd script pubkey conflict for ${issuance.sname}: ${reason}`,
      });
    }
  }
  return { staged, failed, retryable };
}

async function createBatchesForUnbatchedIssuances(input: {
  store: ProtocolIssuanceStore;
  subsd: SubsdClient;
  config: IssuerWorkflowConfig;
  now: string;
}): Promise<{ staged: number; batchesCreated: number; failed: number }> {
  const pending = await input.store.listUnbatchedIssuances(input.config.scanLimit ?? input.config.maxBatchSize);
  let staged = 0;
  let batchesCreated = 0;
  let failed = 0;

  for (const [parentSpace, issuancesForParent] of groupByParentSpace(pending)) {
    const issuances = issuancesForParent.slice(0, input.config.maxBatchSize);
    if (issuances.length === 0) {
      continue;
    }
    const stagedResult = await stageIssuances({ subsd: input.subsd, issuances });
    if (stagedResult.failed.length > 0) {
      failed += stagedResult.failed.length;
      await input.store.markIssuancesFailed({
        issuanceIds: stagedResult.failed.map((failure) => failure.issuance.id),
        errorCode: "subsd_script_pubkey_conflict",
        errorMessage: stagedResult.failed.map((failure) => failure.errorMessage).join("; "),
        now: input.now,
      });
    }
    staged += stagedResult.staged.length;
    const first = stagedResult.staged[0];
    if (!first) {
      continue;
    }
    try {
      await input.store.createBatchWithIssuances({
        id: makeIssuerId("pib"),
        communityId: first.communityId,
        namespaceId: first.namespaceId,
        parentSpace,
        issuanceIds: stagedResult.staged.map((issuance) => issuance.id),
        now: input.now,
      });
      batchesCreated += 1;
    } catch (error) {
      console.warn("Failed to create protocol issuance batch; staged rows remain retryable", {
        parentSpace,
        issuanceIds: stagedResult.staged.map((issuance) => issuance.id),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { staged, batchesCreated, failed };
}

async function commitReadyBatch(input: {
  store: ProtocolIssuanceStore;
  subsd: SubsdClient;
  batch: BatchWithIssuances;
  now: string;
}): Promise<{ committed: boolean; proofRequired: boolean; failed: boolean }> {
  try {
    const committed = await input.subsd.commitLocal({ parentSpace: input.batch.batch.parentSpace });
    await input.store.markBatchCommitted({
      batchId: input.batch.batch.id,
      rootBefore: committed.rootBefore,
      rootAfter: committed.rootAfter,
      proofRequired: committed.proofRequired,
      now: input.now,
    });
    if (committed.proofRequired) {
      return { committed: true, proofRequired: true, failed: false };
    }
    return { committed: true, proofRequired: false, failed: false };
  } catch (error) {
    await input.store.markBatchFailed({
      batchId: input.batch.batch.id,
      errorCode: "subsd_commit_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      now: input.now,
    });
    return { committed: false, proofRequired: false, failed: true };
  }
}

async function broadcastCommittedBatch(input: {
  store: ProtocolIssuanceStore;
  subsd: SubsdClient;
  batch: BatchWithIssuances;
  feeRateSatVb?: number;
  now: string;
}): Promise<{ broadcast: boolean }> {
  if (input.batch.batch.proofRequired && input.batch.batch.workerCheckpoint !== "proving_complete") {
    return { broadcast: false };
  }
  try {
    const broadcast = await input.subsd.broadcastCommit({
      parentSpace: input.batch.batch.parentSpace,
      feeRateSatVb: input.feeRateSatVb,
    });
    if (!broadcast.bitcoinTxid) {
      await input.store.recordBatchRetryableError({
        batchId: input.batch.batch.id,
        errorCode: "subsd_broadcast_missing_txid",
        errorMessage: "subsd broadcast response did not include a Bitcoin txid",
        now: input.now,
      });
      return { broadcast: false };
    }
    await input.store.markBatchBroadcast({
      batchId: input.batch.batch.id,
      bitcoinTxid: broadcast.bitcoinTxid,
      bitcoinCommitRef: broadcast.commitRef,
      now: input.now,
    });
    return { broadcast: true };
  } catch {
    // A local commit may already exist in subsd. Keep the durable checkpoint at "committed"
    // so a later run can retry Bitcoin broadcast without orphaning the local commitment.
    await input.store.recordBatchRetryableError({
      batchId: input.batch.batch.id,
      errorCode: "subsd_broadcast_failed",
      errorMessage: "subsd Bitcoin broadcast failed; retrying from committed checkpoint",
      now: input.now,
    });
    return { broadcast: false };
  }
}

async function submitProofForCommittedBatch(input: {
  store: ProtocolIssuanceStore;
  subsd: SubsdClient;
  proofClient?: ProofJobClient;
  artifactStore?: ProofArtifactStore;
  batch: BatchWithIssuances;
  maxProofJobsPerBatch?: number;
  now: string;
}): Promise<{ submitted: boolean; failed: boolean }> {
  if (!input.proofClient || !input.artifactStore) {
    return { submitted: false, failed: false };
  }
  const maxProofJobs = maxProofJobsPerBatch(input.maxProofJobsPerBatch);
  if (input.batch.batch.proofJobsSubmitted >= maxProofJobs) {
    await failBatchForProofJobLimit({
      store: input.store,
      batch: input.batch,
      maxProofJobs,
      now: input.now,
    });
    return { submitted: false, failed: true };
  }
  try {
    const provingRequest = await input.subsd.getNextProvingRequest({
      parentSpace: input.batch.batch.parentSpace,
    });
    if (!provingRequest.requestBase64) {
      await input.store.recordBatchRetryableError({
        batchId: input.batch.batch.id,
        errorCode: "subsd_proving_request_missing",
        errorMessage: "subsd did not return a pending proving request",
        now: input.now,
      });
      return { submitted: false, failed: false };
    }
    const proofInputRef = await input.artifactStore.putBase64({
      kind: "proof_input",
      batchId: input.batch.batch.id,
      valueBase64: provingRequest.requestBase64,
    });
    const job = await input.proofClient.submitProofJob({
      batchId: input.batch.batch.id,
      parentSpace: input.batch.batch.parentSpace,
      proofInputRef,
      proofInputBase64: provingRequest.requestBase64,
    });
    await input.store.markBatchProvingSubmitted({
      batchId: input.batch.batch.id,
      runpodJobId: job.jobId,
      runpodStatus: job.status,
      proofInputRef,
      now: input.now,
    });
    return { submitted: true, failed: false };
  } catch (error) {
    await input.store.recordBatchRetryableError({
      batchId: input.batch.batch.id,
      errorCode: "proof_submit_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      now: input.now,
    });
    return { submitted: false, failed: false };
  }
}

async function pollSubmittedProofBatch(input: {
  store: ProtocolIssuanceStore;
  subsd: SubsdClient;
  proofClient?: ProofJobClient;
  artifactStore?: ProofArtifactStore;
  batch: BatchWithIssuances;
  proofJobMaxAgeSeconds?: number;
  maxProofJobsPerBatch?: number;
  now: string;
}): Promise<{ completed: boolean; failed: boolean; submittedNext: boolean }> {
  if (!input.proofClient || !input.artifactStore || !input.batch.batch.runpodJobId) {
    return { completed: false, failed: false, submittedNext: false };
  }
  if (isOlderThan({
    timestamp: input.batch.batch.provingSubmittedAt,
    now: input.now,
    maxAgeSeconds: input.proofJobMaxAgeSeconds,
  })) {
    await input.store.markBatchFailed({
      batchId: input.batch.batch.id,
      errorCode: "proof_job_timeout",
      errorMessage: "RunPod proof job exceeded max age",
      now: input.now,
    });
    return { completed: false, failed: true, submittedNext: false };
  }
  try {
    const status = await input.proofClient.getProofJobStatus({
      jobId: input.batch.batch.runpodJobId,
    });
    if (status.status === "queued" || status.status === "running") {
      await input.store.recordBatchRetryableError({
        batchId: input.batch.batch.id,
        errorCode: "proof_job_pending",
        errorMessage: `RunPod proof job is ${status.providerStatus}`,
        now: input.now,
      });
      return { completed: false, failed: false, submittedNext: false };
    }
    if (status.status === "failed") {
      await input.store.markBatchFailed({
        batchId: input.batch.batch.id,
        errorCode: "proof_job_failed",
        errorMessage: status.errorMessage,
        now: input.now,
      });
      return { completed: false, failed: true, submittedNext: false };
    }
    if (status.status !== "completed") {
      return { completed: false, failed: false, submittedNext: false };
    }
    const proofReceiptRef = await input.artifactStore.putBase64({
      kind: "proof_receipt",
      batchId: input.batch.batch.id,
      valueBase64: status.fulfillPayloadBase64,
    });
    const fulfilled = await input.subsd.fulfillProvingRequest({
      parentSpace: input.batch.batch.parentSpace,
      fulfillPayloadBase64: status.fulfillPayloadBase64,
    });
    if (!fulfilled.success) {
      await input.store.recordBatchRetryableError({
        batchId: input.batch.batch.id,
        errorCode: "subsd_proof_fulfill_failed",
        errorMessage: fulfilled.message ?? "subsd proof fulfill failed",
        now: input.now,
      });
      return { completed: false, failed: false, submittedNext: false };
    }
    const nextRequest = await input.subsd.getNextProvingRequest({
      parentSpace: input.batch.batch.parentSpace,
    });
    if (nextRequest.requestBase64) {
      const maxProofJobs = maxProofJobsPerBatch(input.maxProofJobsPerBatch);
      if (input.batch.batch.proofJobsSubmitted >= maxProofJobs) {
        await failBatchForProofJobLimit({
          store: input.store,
          batch: input.batch,
          maxProofJobs,
          now: input.now,
        });
        return { completed: false, failed: true, submittedNext: false };
      }
      const proofInputRef = await input.artifactStore.putBase64({
        kind: "proof_input",
        batchId: input.batch.batch.id,
        valueBase64: nextRequest.requestBase64,
      });
      const nextJob = await input.proofClient.submitProofJob({
        batchId: input.batch.batch.id,
        parentSpace: input.batch.batch.parentSpace,
        proofInputRef,
        proofInputBase64: nextRequest.requestBase64,
      });
      await input.store.markBatchProvingSubmitted({
        batchId: input.batch.batch.id,
        runpodJobId: nextJob.jobId,
        runpodStatus: nextJob.status,
        proofInputRef,
        proofReceiptRef,
        now: input.now,
      });
      return { completed: false, failed: false, submittedNext: true };
    }
    await input.store.markBatchProvingComplete({
      batchId: input.batch.batch.id,
      runpodStatus: status.providerStatus,
      proofReceiptRef,
      now: input.now,
    });
    return { completed: true, failed: false, submittedNext: false };
  } catch (error) {
    await input.store.recordBatchRetryableError({
      batchId: input.batch.batch.id,
      errorCode: "proof_poll_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      now: input.now,
    });
    return { completed: false, failed: false, submittedNext: false };
  }
}

async function fetchCertificates(input: {
  subsd: SubsdClient;
  issuances: PendingProtocolIssuance[];
}): Promise<{
  certificates: Array<{ issuance: PendingProtocolIssuance; certificate: SubsdCertificateResult }>;
  failures: Array<{ issuance: PendingProtocolIssuance; message: string }>;
}> {
  const settled = await Promise.allSettled(input.issuances.map(async (issuance) => ({
    issuance,
    certificate: await input.subsd.getCertificate({ sname: issuance.sname }),
  })));
  const certificates: Array<{ issuance: PendingProtocolIssuance; certificate: SubsdCertificateResult }> = [];
  const failures: Array<{ issuance: PendingProtocolIssuance; message: string }> = [];
  for (const [index, result] of settled.entries()) {
    if (result.status === "fulfilled") {
      certificates.push(result.value);
    } else {
      const issuance = input.issuances[index];
      if (issuance) {
        failures.push({
          issuance,
          message: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
  }
  return { certificates, failures };
}

async function publishFinalizedBatch(input: {
  store: ProtocolIssuanceStore;
  subsd: SubsdClient;
  batch: BatchWithIssuances;
  now: string;
}): Promise<{ published: boolean; failed: boolean }> {
  try {
    const status = await input.subsd.getCommitStatus({ parentSpace: input.batch.batch.parentSpace });
    if (!status.finalized) {
      return { published: false, failed: false };
    }
    const issuances = input.batch.issuances.filter((issuance) => issuance.publicStatus === "issuing");
    if (issuances.length === 0) {
      await input.store.markBatchPublished({
        batchId: input.batch.batch.id,
        fabricSubmissionRef: null,
        now: input.now,
      });
      return { published: true, failed: false };
    }
    const fetched = await fetchCertificates({ subsd: input.subsd, issuances });
    if (fetched.failures.length > 0) {
      await input.store.recordBatchRetryableError({
        batchId: input.batch.batch.id,
        errorCode: "subsd_certificate_fetch_failed",
        errorMessage: fetched.failures.map((failure) => `${failure.issuance.sname}: ${failure.message}`).join("; "),
        now: input.now,
      });
      return { published: false, failed: false };
    }
    const published = await input.subsd.publishCertificates({
      parentSpace: input.batch.batch.parentSpace,
      certificates: fetched.certificates.map((entry) => entry.certificate),
    });
    const issued: MarkIssuanceIssuedInput[] = fetched.certificates.map((entry) => ({
      issuanceId: entry.issuance.id,
      certificatePayloadRef: entry.certificate.certificateRef,
    }));
    await input.store.markIssuancesIssued({
      issuances: issued,
      now: input.now,
    });
    await input.store.markBatchPublished({
      batchId: input.batch.batch.id,
      fabricSubmissionRef: published.fabricSubmissionRef,
      now: input.now,
    });
    return { published: true, failed: false };
  } catch (error) {
    await input.store.markBatchFailed({
      batchId: input.batch.batch.id,
      errorCode: "subsd_publish_failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      now: input.now,
    });
    return { published: false, failed: true };
  }
}

export async function runIssuerWorkflow(input: {
  store: ProtocolIssuanceStore;
  subsd: SubsdClient;
  proofClient?: ProofJobClient;
  artifactStore?: ProofArtifactStore;
  config: IssuerWorkflowConfig;
  now?: Date;
}): Promise<IssuerWorkflowResult> {
  assertPositiveInteger(input.config.minBatchSize, "minBatchSize");
  assertPositiveInteger(input.config.maxBatchSize, "maxBatchSize");
  assertPositiveInteger(input.config.maxBatchAgeSeconds, "maxBatchAgeSeconds");
  if (input.config.minBatchSize > input.config.maxBatchSize) {
    throw new Error("minBatchSize must be <= maxBatchSize");
  }
  if (input.config.maxProofJobsPerBatch !== undefined) {
    assertPositiveInteger(input.config.maxProofJobsPerBatch, "maxProofJobsPerBatch");
  }

  const now = (input.now ?? new Date()).toISOString();
  const created = await createBatchesForUnbatchedIssuances({
    store: input.store,
    subsd: input.subsd,
    config: input.config,
    now,
  });
  const readyBatches = await input.store.listBatchesReadyToCommit({
    minBatchSize: input.config.minBatchSize,
    maxBatchSize: input.config.maxBatchSize,
    maxBatchAgeSeconds: input.config.maxBatchAgeSeconds,
    now,
  });

  let batchesCommitted = 0;
  let batchesNeedingProof = 0;
  let batchesProofSubmitted = 0;
  let batchesProofCompleted = 0;
  let batchesBroadcast = 0;
  let failed = created.failed;
  for (const batch of readyBatches) {
    const result = await commitReadyBatch({
      store: input.store,
      subsd: input.subsd,
      batch,
      now,
    });
    if (result.committed) {
      batchesCommitted += 1;
    }
    if (result.proofRequired) {
      batchesNeedingProof += 1;
    }
    if (result.failed) {
      failed += batch.issuances.length;
    }
  }
  const committedBatches = await input.store.listBatchesByCheckpoint({
    checkpoint: "committed",
    limit: input.config.scanLimit ?? input.config.maxBatchSize,
  });
  for (const batch of committedBatches) {
    if (batch.batch.proofRequired) {
      const result = await submitProofForCommittedBatch({
        store: input.store,
        subsd: input.subsd,
        proofClient: input.proofClient,
        artifactStore: input.artifactStore,
        batch,
        maxProofJobsPerBatch: input.config.maxProofJobsPerBatch,
        now,
      });
      if (result.submitted) {
        batchesProofSubmitted += 1;
      }
      if (result.failed) {
        failed += batch.issuances.length;
      }
    } else {
      const result = await broadcastCommittedBatch({
        store: input.store,
        subsd: input.subsd,
        batch,
        feeRateSatVb: input.config.btcFeeRateSatVb,
        now,
      });
      if (result.broadcast) {
        batchesBroadcast += 1;
      }
    }
  }
  const provingSubmittedBatches = await input.store.listBatchesByCheckpoint({
    checkpoint: "proving_submitted",
    limit: input.config.scanLimit ?? input.config.maxBatchSize,
  });
  for (const batch of provingSubmittedBatches) {
    const result = await pollSubmittedProofBatch({
      store: input.store,
      subsd: input.subsd,
      proofClient: input.proofClient,
      artifactStore: input.artifactStore,
      batch,
      proofJobMaxAgeSeconds: input.config.proofJobMaxAgeSeconds,
      maxProofJobsPerBatch: input.config.maxProofJobsPerBatch,
      now,
    });
    if (result.completed) {
      batchesProofCompleted += 1;
    }
    if (result.submittedNext) {
      batchesProofSubmitted += 1;
    }
    if (result.failed) {
      failed += batch.issuances.length;
    }
  }
  const provingCompleteBatches = await input.store.listBatchesByCheckpoint({
    checkpoint: "proving_complete",
    limit: input.config.scanLimit ?? input.config.maxBatchSize,
  });
  for (const batch of provingCompleteBatches) {
    const result = await broadcastCommittedBatch({
      store: input.store,
      subsd: input.subsd,
      batch,
      feeRateSatVb: input.config.btcFeeRateSatVb,
      now,
    });
    if (result.broadcast) {
      batchesBroadcast += 1;
    }
  }
  const confirmingBatches = await input.store.listBatchesByCheckpoint({
    checkpoint: "confirming",
    limit: input.config.scanLimit ?? input.config.maxBatchSize,
  });
  let batchesPublished = 0;
  for (const batch of confirmingBatches) {
    const result = await publishFinalizedBatch({
      store: input.store,
      subsd: input.subsd,
      batch,
      now,
    });
    if (result.published) {
      batchesPublished += 1;
    }
    if (result.failed) {
      failed += batch.issuances.length;
    }
  }

  return {
    staged: created.staged,
    batchesCreated: created.batchesCreated,
    batchesCommitted,
    batchesNeedingProof,
    batchesProofSubmitted,
    batchesProofCompleted,
    batchesBroadcast,
    batchesPublished,
    failed,
  };
}
