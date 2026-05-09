import { describe, expect, test } from "bun:test";
import { runIssuerWorkflow } from "./issuer-workflow.js";
import { MemoryProofArtifactStore } from "./proof-artifact-store.js";
import type { ProofJobClient, ProofJobStatusResult } from "./runpod-proof-client.js";
import type { SubsdClient, SubsdStageResult } from "./subsd-client.js";
import type {
  BatchWithIssuances,
  CreateBatchWithIssuancesInput,
  MarkBatchBroadcastInput,
  MarkBatchCommittedInput,
  MarkBatchFailedInput,
  MarkBatchPublishedInput,
  MarkBatchProvingSubmittedInput,
  PendingProtocolIssuance,
  ProtocolIssuanceBatch,
  ProtocolIssuanceStore,
} from "./types.js";

function issuance(input: Partial<PendingProtocolIssuance> & { id: string; parentSpace?: string; sname?: string }): PendingProtocolIssuance {
  return {
    id: input.id,
    communityHandleId: input.communityHandleId ?? `ch_${input.id}`,
    communityId: input.communityId ?? "cmt_test",
    namespaceId: input.namespaceId ?? "ns_test",
    publicStatus: input.publicStatus ?? "issuing",
    parentSpace: input.parentSpace ?? "@pesto",
    sname: input.sname ?? `${input.id}@pesto`,
    scriptPubkeyHex: input.scriptPubkeyHex ?? "5120a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c",
    createdAt: input.createdAt ?? "2026-05-09T00:00:00.000Z",
  };
}

class MemoryStore implements ProtocolIssuanceStore {
  readonly pending: PendingProtocolIssuance[];
  readonly batches = new Map<string, ProtocolIssuanceBatch>();
  readonly batchIssuanceIds = new Map<string, string[]>();
  readonly committed: MarkBatchCommittedInput[] = [];
  readonly broadcast: MarkBatchBroadcastInput[] = [];
  readonly published: MarkBatchPublishedInput[] = [];
  readonly issuedIssuances: Array<{ id: string; certificatePayloadRef: string | null }> = [];
  readonly failed: MarkBatchFailedInput[] = [];
  readonly retryableErrors: MarkBatchFailedInput[] = [];
  readonly failedIssuances: Array<{ id: string; errorCode: string; errorMessage: string }> = [];

  constructor(pending: PendingProtocolIssuance[]) {
    this.pending = pending;
  }

  async listUnbatchedIssuances(limit: number): Promise<PendingProtocolIssuance[]> {
    return this.pending
      .filter((row) => row.publicStatus === "issuing" && ![...this.batchIssuanceIds.values()].flat().includes(row.id))
      .slice(0, limit);
  }

  async createBatchWithIssuances(input: CreateBatchWithIssuancesInput): Promise<ProtocolIssuanceBatch> {
    const batch: ProtocolIssuanceBatch = {
      id: input.id,
      communityId: input.communityId,
      namespaceId: input.namespaceId,
      parentSpace: input.parentSpace,
      status: "open",
      workerCheckpoint: "staged",
      proofRequired: false,
      subsdRootBefore: null,
      subsdRootAfter: null,
      runpodJobId: null,
      runpodStatus: null,
      proofInputRef: null,
      proofReceiptRef: null,
      proofJobsSubmitted: 0,
      errorCode: null,
      errorMessage: null,
      createdAt: input.now,
      updatedAt: input.now,
      provingSubmittedAt: null,
    };
    this.batches.set(batch.id, batch);
    this.batchIssuanceIds.set(input.id, input.issuanceIds);
    return batch;
  }

  async markIssuancesFailed(input: { issuanceIds: string[]; errorCode: string; errorMessage: string }): Promise<void> {
    this.failedIssuances.push(...input.issuanceIds.map((id) => ({
      id,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
    })));
    for (const issuanceId of input.issuanceIds) {
      const row = this.pending.find((candidate) => candidate.id === issuanceId);
      if (row) {
        row.publicStatus = "failed";
      }
    }
  }

  async listBatchesReadyToCommit(input: { minBatchSize: number; maxBatchSize: number; maxBatchAgeSeconds: number; now: string }): Promise<BatchWithIssuances[]> {
    const cutoff = Date.parse(input.now) - input.maxBatchAgeSeconds * 1000;
    const ready: BatchWithIssuances[] = [];
    for (const batch of this.batches.values()) {
      if (batch.status !== "open" || batch.workerCheckpoint !== "staged") {
        continue;
      }
      const ids = this.batchIssuanceIds.get(batch.id) ?? [];
      if (ids.length === 0 || ids.length > input.maxBatchSize) {
        continue;
      }
      if (ids.length < input.minBatchSize && Date.parse(batch.createdAt) > cutoff) {
        continue;
      }
      ready.push({
        batch,
        issuances: this.pending.filter((row) => ids.includes(row.id)),
      });
    }
    return ready;
  }

  async markBatchCommitted(input: MarkBatchCommittedInput): Promise<void> {
    this.committed.push(input);
    const batch = this.batches.get(input.batchId);
    if (batch) {
      batch.status = "processing";
      batch.workerCheckpoint = "committed";
      batch.proofRequired = input.proofRequired;
      batch.subsdRootBefore = input.rootBefore;
      batch.subsdRootAfter = input.rootAfter;
      batch.errorCode = null;
      batch.errorMessage = null;
    }
  }

  async markBatchProvingSubmitted(input: MarkBatchProvingSubmittedInput): Promise<void> {
    const batch = this.batches.get(input.batchId);
    if (batch) {
      batch.workerCheckpoint = "proving_submitted";
      batch.runpodJobId = input.runpodJobId;
      batch.runpodStatus = input.runpodStatus;
      batch.proofInputRef = input.proofInputRef;
      batch.proofJobsSubmitted += 1;
      if (input.proofReceiptRef !== undefined) {
        batch.proofReceiptRef = input.proofReceiptRef;
      }
      batch.errorCode = null;
      batch.errorMessage = null;
      batch.provingSubmittedAt = "2026-05-09T00:05:00.000Z";
    }
  }

  async markBatchProvingComplete(input: { batchId: string; runpodStatus: string; proofReceiptRef: string }): Promise<void> {
    const batch = this.batches.get(input.batchId);
    if (batch) {
      batch.workerCheckpoint = "proving_complete";
      batch.runpodStatus = input.runpodStatus;
      batch.proofReceiptRef = input.proofReceiptRef;
      batch.errorCode = null;
      batch.errorMessage = null;
    }
  }

  async listBatchesByCheckpoint(input: { checkpoint: ProtocolIssuanceBatch["workerCheckpoint"]; limit: number }): Promise<BatchWithIssuances[]> {
    const batches: BatchWithIssuances[] = [];
    for (const batch of this.batches.values()) {
      if (batch.workerCheckpoint !== input.checkpoint || batch.status !== "processing") {
        continue;
      }
      const ids = this.batchIssuanceIds.get(batch.id) ?? [];
      batches.push({
        batch,
        issuances: this.pending.filter((row) => ids.includes(row.id)),
      });
      if (batches.length >= input.limit) {
        break;
      }
    }
    return batches;
  }

  async markBatchBroadcast(input: MarkBatchBroadcastInput): Promise<void> {
    this.broadcast.push(input);
    const batch = this.batches.get(input.batchId);
    if (batch) {
      batch.workerCheckpoint = "confirming";
      batch.errorCode = null;
      batch.errorMessage = null;
    }
  }

  async markBatchPublished(input: MarkBatchPublishedInput): Promise<void> {
    this.published.push(input);
    const batch = this.batches.get(input.batchId);
    if (batch) {
      batch.status = "published";
      batch.workerCheckpoint = "published";
      batch.errorCode = null;
      batch.errorMessage = null;
    }
  }

  async markIssuancesIssued(input: { issuances: Array<{ issuanceId: string; certificatePayloadRef: string | null }> }): Promise<void> {
    this.issuedIssuances.push(...input.issuances.map((issuance) => ({
      id: issuance.issuanceId,
      certificatePayloadRef: issuance.certificatePayloadRef,
    })));
    for (const issuance of input.issuances) {
      const row = this.pending.find((candidate) => candidate.id === issuance.issuanceId);
      if (row) {
        row.publicStatus = "issued";
      }
    }
  }

  async recordBatchRetryableError(input: MarkBatchFailedInput): Promise<void> {
    this.retryableErrors.push(input);
    const batch = this.batches.get(input.batchId);
    if (batch) {
      batch.errorCode = input.errorCode;
      batch.errorMessage = input.errorMessage;
    }
  }

  async markBatchFailed(input: MarkBatchFailedInput): Promise<void> {
    this.failed.push(input);
    const batch = this.batches.get(input.batchId);
    if (batch) {
      batch.status = "failed";
      batch.workerCheckpoint = "failed";
      batch.errorCode = input.errorCode;
      batch.errorMessage = input.errorMessage;
      const issuanceIds = this.batchIssuanceIds.get(batch.id) ?? [];
      for (const issuanceId of issuanceIds) {
        const row = this.pending.find((candidate) => candidate.id === issuanceId);
        if (row && row.publicStatus === "issuing") {
          row.publicStatus = "failed";
        }
      }
    }
  }
}

function mockSubsd(input?: {
  stage?: (request: { parentSpace: string; sname: string }) => SubsdStageResult;
  proofRequired?: boolean;
  finalized?: boolean;
  broadcastError?: Error;
  broadcastTxid?: string | null;
  certificateErrorFor?: string;
  provingRequestBase64?: string | null;
  provingRequestSequence?: Array<string | null>;
}): SubsdClient & { staged: string[]; committedSpaces: string[]; broadcastSpaces: string[]; publishedSpaces: string[]; fulfilledProofs: string[] } {
  const staged: string[] = [];
  const committedSpaces: string[] = [];
  const broadcastSpaces: string[] = [];
  const publishedSpaces: string[] = [];
  const fulfilledProofs: string[] = [];
  const provingRequestSequence = input?.provingRequestSequence ? [...input.provingRequestSequence] : null;
  return {
    staged,
    committedSpaces,
    broadcastSpaces,
    publishedSpaces,
    fulfilledProofs,
    async stageRequest(request) {
      staged.push(request.sname);
      return input?.stage?.(request) ?? { status: "staged" };
    },
    async commitLocal(request) {
      committedSpaces.push(request.parentSpace);
      return {
        rootBefore: "root-before",
        rootAfter: "root-after",
        proofRequired: input?.proofRequired ?? false,
      };
    },
    async getNextProvingRequest() {
      if (provingRequestSequence) {
        return {
          requestBase64: provingRequestSequence.shift() ?? null,
        };
      }
      return {
        requestBase64: input?.provingRequestBase64 === undefined ? "proof-input" : input.provingRequestBase64,
      };
    },
    async fulfillProvingRequest(request) {
      fulfilledProofs.push(request.fulfillPayloadBase64);
      return {
        success: true,
        message: null,
      };
    },
    async broadcastCommit(request) {
      broadcastSpaces.push(request.parentSpace);
      if (input?.broadcastError) {
        throw input.broadcastError;
      }
      return {
        bitcoinTxid: input?.broadcastTxid === undefined ? "tx-test" : input.broadcastTxid,
        commitRef: input?.broadcastTxid === undefined ? "commit-test" : input.broadcastTxid,
      };
    },
    async getCommitStatus() {
      return {
        finalized: input?.finalized ?? false,
        confirmations: input?.finalized ? 150 : 1,
      };
    },
    async getCertificate(request) {
      if (request.sname === input?.certificateErrorFor) {
        throw new Error("certificate missing");
      }
      return {
        sname: request.sname,
        certificatePayload: { handle: request.sname },
        certificateRef: `cert:${request.sname}`,
      };
    },
    async publishCertificates(request) {
      publishedSpaces.push(request.parentSpace);
      return {
        fabricSubmissionRef: "fabric-test",
      };
    },
  };
}

function mockProofClient(input?: {
  status?: ProofJobStatusResult;
}): ProofJobClient & { submitted: Array<{ batchId: string; proofInputRef: string; proofInputBase64: string }> } {
  const submitted: Array<{ batchId: string; proofInputRef: string; proofInputBase64: string }> = [];
  return {
    submitted,
    async submitProofJob(job) {
      submitted.push({
        batchId: job.batchId,
        proofInputRef: job.proofInputRef,
        proofInputBase64: job.proofInputBase64,
      });
      return {
        jobId: "rp_job_test",
        status: "IN_QUEUE",
      };
    },
    async getProofJobStatus() {
      return input?.status ?? {
        status: "completed",
        providerStatus: "COMPLETED",
        fulfillPayloadBase64: "fulfill-payload",
      };
    },
  };
}

describe("issuer workflow", () => {
  test("stages unbatched handles, creates a parent-space batch, and commits when threshold is met", async () => {
    const store = new MemoryStore([
      issuance({ id: "ice" }),
      issuance({ id: "snow" }),
    ]);
    const subsd = mockSubsd({ provingRequestBase64: null });

    const result = await runIssuerWorkflow({
      store,
      subsd,
      config: { minBatchSize: 2, maxBatchSize: 10, maxBatchAgeSeconds: 1800 },
      now: new Date("2026-05-09T00:05:00.000Z"),
    });

    expect(result).toEqual({
      staged: 2,
      batchesCreated: 1,
      batchesCommitted: 1,
      batchesNeedingProof: 0,
      batchesProofSubmitted: 0,
      batchesProofCompleted: 0,
      batchesBroadcast: 1,
      batchesPublished: 0,
      failed: 0,
    });
    expect(subsd.staged).toEqual(["ice@pesto", "snow@pesto"]);
    expect(subsd.committedSpaces).toEqual(["@pesto"]);
    expect(store.committed[0]).toMatchObject({
      rootBefore: "root-before",
      rootAfter: "root-after",
      proofRequired: false,
    });
  });

  test("treats AlreadyCommitted as an idempotent staging success", async () => {
    const store = new MemoryStore([issuance({ id: "done" })]);
    const subsd = mockSubsd({ stage: () => ({ status: "already_committed" }) });

    const result = await runIssuerWorkflow({
      store,
      subsd,
      config: { minBatchSize: 1, maxBatchSize: 5, maxBatchAgeSeconds: 1800 },
      now: new Date("2026-05-09T00:05:00.000Z"),
    });

    expect(result.failed).toBe(0);
    expect(result.batchesCommitted).toBe(1);
  });

  test("isolates a script pubkey conflict to the conflicting handle and batches staged neighbors", async () => {
    const store = new MemoryStore([
      issuance({ id: "ok1" }),
      issuance({ id: "taken" }),
      issuance({ id: "ok2" }),
    ]);
    const subsd = mockSubsd({
      stage: (request) => request.sname === "taken@pesto"
        ? { status: "script_pubkey_conflict", reason: "already_staged_different_spk" }
        : { status: "staged" },
    });

    const result = await runIssuerWorkflow({
      store,
      subsd,
      config: { minBatchSize: 1, maxBatchSize: 5, maxBatchAgeSeconds: 1800 },
      now: new Date("2026-05-09T00:05:00.000Z"),
    });

    expect(result.failed).toBe(1);
    expect(result.staged).toBe(2);
    expect(result.batchesCreated).toBe(1);
    expect(result.batchesCommitted).toBe(1);
    expect(store.failedIssuances).toEqual([
      {
        id: "taken",
        errorCode: "subsd_script_pubkey_conflict",
        errorMessage: "subsd script pubkey conflict for taken@pesto: already_staged_different_spk",
      },
    ]);
    expect([...store.batchIssuanceIds.values()][0]).toEqual(["ok1", "ok2"]);
  });

  test("leaves rows retryable when staging fails before subsd returns a handle-level outcome", async () => {
    const store = new MemoryStore([
      issuance({ id: "ok-before" }),
      issuance({ id: "transient" }),
    ]);
    const subsd = mockSubsd({
      stage: (request) => {
        if (request.sname === "transient@pesto") {
          throw new Error("subsd unavailable");
        }
        return { status: "staged" };
      },
    });

    const result = await runIssuerWorkflow({
      store,
      subsd,
      config: { minBatchSize: 1, maxBatchSize: 5, maxBatchAgeSeconds: 1800 },
      now: new Date("2026-05-09T00:05:00.000Z"),
    });

    expect(result).toMatchObject({
      staged: 1,
      batchesCreated: 1,
      batchesCommitted: 1,
      failed: 0,
    });
    expect(store.failedIssuances).toEqual([]);
    expect([...store.batchIssuanceIds.values()][0]).toEqual(["ok-before"]);
    expect(store.pending.find((row) => row.id === "transient")?.publicStatus).toBe("issuing");
  });

  test("continues staging other parent spaces when one parent has a transient stage failure", async () => {
    const store = new MemoryStore([
      issuance({ id: "pesto-fail", parentSpace: "@pesto", sname: "pesto-fail@pesto" }),
      issuance({ id: "cocos-ok", parentSpace: "@cocos", sname: "cocos-ok@cocos" }),
    ]);
    const subsd = mockSubsd({
      stage: (request) => {
        if (request.parentSpace === "@pesto") {
          throw new Error("subsd pesto unavailable");
        }
        return { status: "staged" };
      },
    });

    const result = await runIssuerWorkflow({
      store,
      subsd,
      config: { minBatchSize: 1, maxBatchSize: 5, maxBatchAgeSeconds: 1800 },
      now: new Date("2026-05-09T00:05:00.000Z"),
    });

    expect(result.failed).toBe(0);
    expect(result.staged).toBe(1);
    expect(result.batchesCreated).toBe(1);
    expect(subsd.committedSpaces).toEqual(["@cocos"]);
    expect([...store.batchIssuanceIds.values()][0]).toEqual(["cocos-ok"]);
    expect(store.pending.find((row) => row.id === "pesto-fail")?.publicStatus).toBe("issuing");
  });

  test("does not commit an oversized preexisting batch", async () => {
    const rows = [
      issuance({ id: "one" }),
      issuance({ id: "two" }),
      issuance({ id: "three" }),
    ];
    const store = new MemoryStore(rows);
    await store.createBatchWithIssuances({
      id: "pib_oversized",
      communityId: "cmt_test",
      namespaceId: "ns_test",
      parentSpace: "@pesto",
      issuanceIds: rows.map((row) => row.id),
      now: "2026-05-09T00:00:00.000Z",
    });
    const subsd = mockSubsd({ provingRequestBase64: null });

    const result = await runIssuerWorkflow({
      store,
      subsd,
      config: { minBatchSize: 1, maxBatchSize: 2, maxBatchAgeSeconds: 1 },
      now: new Date("2026-05-09T00:05:00.000Z"),
    });

    expect(result.batchesCommitted).toBe(0);
    expect(subsd.committedSpaces).toEqual([]);
  });

  test("records proof-required batches without trying to prove them", async () => {
    const store = new MemoryStore([issuance({ id: "proof" })]);
    const subsd = mockSubsd({ proofRequired: true });

    const result = await runIssuerWorkflow({
      store,
      subsd,
      config: { minBatchSize: 1, maxBatchSize: 5, maxBatchAgeSeconds: 1800 },
      now: new Date("2026-05-09T00:05:00.000Z"),
    });

    expect(result.batchesCommitted).toBe(1);
    expect(result.batchesNeedingProof).toBe(1);
    expect(result.batchesBroadcast).toBe(0);
    expect(store.committed[0]?.proofRequired).toBe(true);
  });

  test("submits proof-required committed batches to proof backend", async () => {
    const store = new MemoryStore([issuance({ id: "proof-submit" })]);
    const subsd = mockSubsd({ proofRequired: true, provingRequestBase64: "proof-input" });
    const proofClient = mockProofClient({
      status: { status: "queued", providerStatus: "IN_QUEUE" },
    });
    const artifactStore = new MemoryProofArtifactStore();

    const result = await runIssuerWorkflow({
      store,
      subsd,
      proofClient,
      artifactStore,
      config: { minBatchSize: 1, maxBatchSize: 5, maxBatchAgeSeconds: 1800 },
      now: new Date("2026-05-09T00:05:00.000Z"),
    });

    expect(result).toMatchObject({
      batchesCommitted: 1,
      batchesNeedingProof: 1,
      batchesProofSubmitted: 1,
      failed: 0,
    });
    expect(proofClient.submitted[0]).toMatchObject({
      proofInputBase64: "proof-input",
    });
    const batch = [...store.batches.values()][0];
    expect(batch).toMatchObject({
      workerCheckpoint: "proving_submitted",
      runpodJobId: "rp_job_test",
      runpodStatus: "IN_QUEUE",
    });
    expect(batch?.proofJobsSubmitted).toBe(1);
    expect(batch?.proofInputRef).toStartWith("memory://");
  });

  test("fails proof-required batches before submitting beyond the proof job cap", async () => {
    const row = issuance({ id: "proof-limit" });
    const store = new MemoryStore([row]);
    const batch = await store.createBatchWithIssuances({
      id: "pib_proof_limit",
      communityId: row.communityId,
      namespaceId: row.namespaceId,
      parentSpace: row.parentSpace,
      issuanceIds: [row.id],
      now: "2026-05-09T00:00:00.000Z",
    });
    batch.status = "processing";
    batch.workerCheckpoint = "committed";
    batch.proofRequired = true;
    batch.proofJobsSubmitted = 1;
    const proofClient = mockProofClient();

    const result = await runIssuerWorkflow({
      store,
      subsd: mockSubsd({ provingRequestBase64: "proof-input" }),
      proofClient,
      artifactStore: new MemoryProofArtifactStore(),
      config: {
        minBatchSize: 1,
        maxBatchSize: 5,
        maxBatchAgeSeconds: 1800,
        maxProofJobsPerBatch: 1,
      },
      now: new Date("2026-05-09T00:05:00.000Z"),
    });

    expect(result.failed).toBe(1);
    expect(proofClient.submitted).toEqual([]);
    expect(batch).toMatchObject({
      status: "failed",
      workerCheckpoint: "failed",
      errorCode: "proof_job_limit_exceeded",
    });
    expect(row.publicStatus).toBe("failed");
  });

  test("fulfills completed proof jobs and broadcasts the proved batch", async () => {
    const row = issuance({ id: "proof-complete" });
    const store = new MemoryStore([row]);
    const batch = await store.createBatchWithIssuances({
      id: "pib_proving",
      communityId: row.communityId,
      namespaceId: row.namespaceId,
      parentSpace: row.parentSpace,
      issuanceIds: [row.id],
      now: "2026-05-09T00:00:00.000Z",
    });
    batch.status = "processing";
    batch.workerCheckpoint = "proving_submitted";
    batch.proofRequired = true;
    batch.runpodJobId = "rp_job_test";
    const subsd = mockSubsd({ provingRequestBase64: null });
    const proofClient = mockProofClient();
    const artifactStore = new MemoryProofArtifactStore();

    const result = await runIssuerWorkflow({
      store,
      subsd,
      proofClient,
      artifactStore,
      config: { minBatchSize: 1, maxBatchSize: 5, maxBatchAgeSeconds: 1800 },
      now: new Date("2026-05-09T00:05:00.000Z"),
    });

    expect(result).toMatchObject({
      batchesProofCompleted: 1,
      batchesBroadcast: 1,
    });
    expect(subsd.fulfilledProofs).toEqual(["fulfill-payload"]);
    expect(batch).toMatchObject({
      workerCheckpoint: "confirming",
      runpodStatus: "COMPLETED",
    });
    expect(batch.proofReceiptRef).toStartWith("memory://");
  });

  test("submits another proof job when subsd has additional proving requests", async () => {
    const row = issuance({ id: "proof-more" });
    const store = new MemoryStore([row]);
    const batch = await store.createBatchWithIssuances({
      id: "pib_more_proving",
      communityId: row.communityId,
      namespaceId: row.namespaceId,
      parentSpace: row.parentSpace,
      issuanceIds: [row.id],
      now: "2026-05-09T00:00:00.000Z",
    });
    batch.status = "processing";
    batch.workerCheckpoint = "proving_submitted";
    batch.proofRequired = true;
    batch.runpodJobId = "rp_job_first";
    batch.proofJobsSubmitted = 1;
    const subsd = mockSubsd({ provingRequestSequence: ["next-proof-input"] });
    const proofClient = mockProofClient();
    const artifactStore = new MemoryProofArtifactStore();

    const result = await runIssuerWorkflow({
      store,
      subsd,
      proofClient,
      artifactStore,
      config: { minBatchSize: 1, maxBatchSize: 5, maxBatchAgeSeconds: 1800 },
      now: new Date("2026-05-09T00:05:00.000Z"),
    });

    expect(result).toMatchObject({
      batchesProofCompleted: 0,
      batchesProofSubmitted: 1,
      batchesBroadcast: 0,
    });
    expect(subsd.fulfilledProofs).toEqual(["fulfill-payload"]);
    expect(proofClient.submitted).toHaveLength(1);
    expect(proofClient.submitted[0]?.proofInputBase64).toBe("next-proof-input");
    expect(batch).toMatchObject({
      workerCheckpoint: "proving_submitted",
      runpodStatus: "IN_QUEUE",
    });
    expect(batch.proofJobsSubmitted).toBe(2);
    expect(batch.proofReceiptRef).toStartWith("memory://");
  });

  test("fails multi-proof batches instead of submitting beyond the proof job cap", async () => {
    const row = issuance({ id: "proof-more-limit" });
    const store = new MemoryStore([row]);
    const batch = await store.createBatchWithIssuances({
      id: "pib_more_proving_limit",
      communityId: row.communityId,
      namespaceId: row.namespaceId,
      parentSpace: row.parentSpace,
      issuanceIds: [row.id],
      now: "2026-05-09T00:00:00.000Z",
    });
    batch.status = "processing";
    batch.workerCheckpoint = "proving_submitted";
    batch.proofRequired = true;
    batch.runpodJobId = "rp_job_first";
    batch.proofJobsSubmitted = 1;
    const subsd = mockSubsd({ provingRequestSequence: ["next-proof-input"] });
    const proofClient = mockProofClient();

    const result = await runIssuerWorkflow({
      store,
      subsd,
      proofClient,
      artifactStore: new MemoryProofArtifactStore(),
      config: {
        minBatchSize: 1,
        maxBatchSize: 5,
        maxBatchAgeSeconds: 1800,
        maxProofJobsPerBatch: 1,
      },
      now: new Date("2026-05-09T00:05:00.000Z"),
    });

    expect(result).toMatchObject({
      batchesProofCompleted: 0,
      batchesProofSubmitted: 0,
      batchesBroadcast: 0,
      failed: 1,
    });
    expect(subsd.fulfilledProofs).toEqual(["fulfill-payload"]);
    expect(proofClient.submitted).toEqual([]);
    expect(batch).toMatchObject({
      status: "failed",
      workerCheckpoint: "failed",
      errorCode: "proof_job_limit_exceeded",
    });
    expect(row.publicStatus).toBe("failed");
  });

  test("marks failed RunPod jobs terminal instead of retrying forever", async () => {
    const row = issuance({ id: "proof-failed" });
    const store = new MemoryStore([row]);
    const batch = await store.createBatchWithIssuances({
      id: "pib_failed_proof",
      communityId: row.communityId,
      namespaceId: row.namespaceId,
      parentSpace: row.parentSpace,
      issuanceIds: [row.id],
      now: "2026-05-09T00:00:00.000Z",
    });
    batch.status = "processing";
    batch.workerCheckpoint = "proving_submitted";
    batch.proofRequired = true;
    batch.runpodJobId = "rp_job_failed";
    const proofClient = mockProofClient({
      status: {
        status: "failed",
        providerStatus: "FAILED",
        errorMessage: "worker crashed",
      },
    });

    const result = await runIssuerWorkflow({
      store,
      subsd: mockSubsd(),
      proofClient,
      artifactStore: new MemoryProofArtifactStore(),
      config: { minBatchSize: 1, maxBatchSize: 5, maxBatchAgeSeconds: 1800 },
      now: new Date("2026-05-09T00:05:00.000Z"),
    });

    expect(result.failed).toBe(1);
    expect(batch).toMatchObject({
      status: "failed",
      workerCheckpoint: "failed",
      errorCode: "proof_job_failed",
      errorMessage: "worker crashed",
    });
    expect(row.publicStatus).toBe("failed");
  });

  test("marks stale RunPod jobs failed after max proof age", async () => {
    const row = issuance({ id: "proof-timeout" });
    const store = new MemoryStore([row]);
    const batch = await store.createBatchWithIssuances({
      id: "pib_timeout_proof",
      communityId: row.communityId,
      namespaceId: row.namespaceId,
      parentSpace: row.parentSpace,
      issuanceIds: [row.id],
      now: "2026-05-09T00:00:00.000Z",
    });
    batch.status = "processing";
    batch.workerCheckpoint = "proving_submitted";
    batch.proofRequired = true;
    batch.runpodJobId = "rp_job_stale";
    batch.provingSubmittedAt = "2026-05-09T00:00:00.000Z";

    const result = await runIssuerWorkflow({
      store,
      subsd: mockSubsd(),
      proofClient: mockProofClient({ status: { status: "running", providerStatus: "IN_PROGRESS" } }),
      artifactStore: new MemoryProofArtifactStore(),
      config: {
        minBatchSize: 1,
        maxBatchSize: 5,
        maxBatchAgeSeconds: 1800,
        proofJobMaxAgeSeconds: 60,
      },
      now: new Date("2026-05-09T00:05:00.000Z"),
    });

    expect(result.failed).toBe(1);
    expect(batch).toMatchObject({
      status: "failed",
      workerCheckpoint: "failed",
      errorCode: "proof_job_timeout",
    });
    expect(row.publicStatus).toBe("failed");
  });

  test("broadcasts proof-required batches only after proving is complete", async () => {
    const row = issuance({ id: "proved" });
    const store = new MemoryStore([row]);
    const batch = await store.createBatchWithIssuances({
      id: "pib_proved",
      communityId: row.communityId,
      namespaceId: row.namespaceId,
      parentSpace: row.parentSpace,
      issuanceIds: [row.id],
      now: "2026-05-09T00:00:00.000Z",
    });
    batch.status = "processing";
    batch.workerCheckpoint = "proving_complete";
    batch.proofRequired = true;
    const subsd = mockSubsd();

    const result = await runIssuerWorkflow({
      store,
      subsd,
      config: { minBatchSize: 1, maxBatchSize: 5, maxBatchAgeSeconds: 1800 },
      now: new Date("2026-05-09T00:05:00.000Z"),
    });

    expect(result.batchesBroadcast).toBe(1);
    expect(batch.workerCheckpoint).toBe("confirming");
  });

  test("leaves committed proofless batches retryable when Bitcoin broadcast fails", async () => {
    const store = new MemoryStore([issuance({ id: "retry" })]);
    const subsd = mockSubsd({ broadcastError: new Error("fee too low") });

    const result = await runIssuerWorkflow({
      store,
      subsd,
      config: { minBatchSize: 1, maxBatchSize: 5, maxBatchAgeSeconds: 1800 },
      now: new Date("2026-05-09T00:05:00.000Z"),
    });

    expect(result).toMatchObject({
      batchesCommitted: 1,
      batchesBroadcast: 0,
      failed: 0,
    });
    const batch = [...store.batches.values()][0];
    expect(batch).toMatchObject({
      status: "processing",
      workerCheckpoint: "committed",
      proofRequired: false,
    });
    expect(store.failed).toEqual([]);
    expect(store.retryableErrors[0]).toMatchObject({
      errorCode: "subsd_broadcast_failed",
    });
  });

  test("does not advance committed batches when broadcast response has no txid", async () => {
    const store = new MemoryStore([issuance({ id: "missing-txid" })]);
    const subsd = mockSubsd({ broadcastTxid: null });

    const result = await runIssuerWorkflow({
      store,
      subsd,
      config: { minBatchSize: 1, maxBatchSize: 5, maxBatchAgeSeconds: 1800 },
      now: new Date("2026-05-09T00:05:00.000Z"),
    });

    expect(result.batchesBroadcast).toBe(0);
    const batch = [...store.batches.values()][0];
    expect(batch).toMatchObject({
      status: "processing",
      workerCheckpoint: "committed",
      errorCode: "subsd_broadcast_missing_txid",
    });
  });

  test("publishes a confirming proofless batch once finality is observed", async () => {
    const row = issuance({ id: "issued" });
    const store = new MemoryStore([row]);
    const batch = await store.createBatchWithIssuances({
      id: "pib_confirming",
      communityId: row.communityId,
      namespaceId: row.namespaceId,
      parentSpace: row.parentSpace,
      issuanceIds: [row.id],
      now: "2026-05-09T00:00:00.000Z",
    });
    batch.status = "processing";
    batch.workerCheckpoint = "confirming";
    const subsd = mockSubsd({ finalized: true });

    const result = await runIssuerWorkflow({
      store,
      subsd,
      config: { minBatchSize: 1, maxBatchSize: 5, maxBatchAgeSeconds: 1800 },
      now: new Date("2026-05-09T00:05:00.000Z"),
    });

    expect(result.batchesPublished).toBe(1);
    expect(store.issuedIssuances).toEqual([{
      id: "issued",
      certificatePayloadRef: "cert:issued@pesto",
    }]);
    expect(store.published[0]).toMatchObject({
      batchId: "pib_confirming",
      fabricSubmissionRef: "fabric-test",
    });
    expect(subsd.publishedSpaces).toEqual(["@pesto"]);
  });

  test("keeps confirming batch retryable when any certificate fetch fails", async () => {
    const rows = [issuance({ id: "ok" }), issuance({ id: "missing" })];
    const store = new MemoryStore(rows);
    const batch = await store.createBatchWithIssuances({
      id: "pib_cert_retry",
      communityId: "cmt_test",
      namespaceId: "ns_test",
      parentSpace: "@pesto",
      issuanceIds: rows.map((row) => row.id),
      now: "2026-05-09T00:00:00.000Z",
    });
    batch.status = "processing";
    batch.workerCheckpoint = "confirming";
    const subsd = mockSubsd({ finalized: true, certificateErrorFor: "missing@pesto" });

    const result = await runIssuerWorkflow({
      store,
      subsd,
      config: { minBatchSize: 1, maxBatchSize: 5, maxBatchAgeSeconds: 1800 },
      now: new Date("2026-05-09T00:05:00.000Z"),
    });

    expect(result).toMatchObject({
      batchesPublished: 0,
      failed: 0,
    });
    expect(store.issuedIssuances).toEqual([]);
    expect(store.published).toEqual([]);
    expect(batch).toMatchObject({
      status: "processing",
      workerCheckpoint: "confirming",
      errorCode: "subsd_certificate_fetch_failed",
    });
  });
});
