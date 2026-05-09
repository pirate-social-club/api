export type ProtocolIssuancePublicStatus = "issuing" | "issued" | "failed";

export type ProtocolIssuanceBatchStatus = "open" | "processing" | "published" | "failed";

export type ProtocolIssuanceCheckpoint =
  | "pending_stage"
  | "staged"
  | "batched"
  | "committed"
  | "proving_submitted"
  | "proving_complete"
  | "broadcast"
  | "confirming"
  | "published"
  | "failed";

export type PendingProtocolIssuance = {
  id: string;
  communityHandleId: string;
  communityId: string;
  namespaceId: string;
  publicStatus: ProtocolIssuancePublicStatus;
  parentSpace: string;
  sname: string;
  scriptPubkeyHex: string;
  createdAt: string;
};

export type ProtocolIssuanceBatch = {
  id: string;
  communityId: string;
  namespaceId: string;
  parentSpace: string;
  status: ProtocolIssuanceBatchStatus;
  workerCheckpoint: ProtocolIssuanceCheckpoint;
  proofRequired: boolean;
  subsdRootBefore: string | null;
  subsdRootAfter: string | null;
  runpodJobId: string | null;
  runpodStatus: string | null;
  proofInputRef: string | null;
  proofReceiptRef: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  provingSubmittedAt: string | null;
};

export type BatchWithIssuances = {
  batch: ProtocolIssuanceBatch;
  issuances: PendingProtocolIssuance[];
};

export type CreateBatchInput = {
  id: string;
  communityId: string;
  namespaceId: string;
  parentSpace: string;
  now: string;
};

export type CreateBatchWithIssuancesInput = CreateBatchInput & {
  issuanceIds: string[];
};

export type MarkBatchCommittedInput = {
  batchId: string;
  rootBefore: string | null;
  rootAfter: string | null;
  proofRequired: boolean;
  now: string;
};

export type MarkBatchFailedInput = {
  batchId: string;
  errorCode: string;
  errorMessage: string;
  now: string;
};

export type MarkBatchBroadcastInput = {
  batchId: string;
  bitcoinTxid: string;
  bitcoinCommitRef: string | null;
  now: string;
};

export type MarkBatchPublishedInput = {
  batchId: string;
  fabricSubmissionRef: string | null;
  now: string;
};

export type MarkBatchProvingSubmittedInput = {
  batchId: string;
  runpodJobId: string;
  runpodStatus: string;
  proofInputRef: string;
  now: string;
};

export type MarkBatchProvingCompleteInput = {
  batchId: string;
  runpodStatus: string;
  proofReceiptRef: string;
  now: string;
};

export type MarkIssuanceIssuedInput = {
  issuanceId: string;
  certificatePayloadRef: string | null;
};

export type ProtocolIssuanceStore = {
  listUnbatchedIssuances(limit: number): Promise<PendingProtocolIssuance[]>;
  createBatchWithIssuances(input: CreateBatchWithIssuancesInput): Promise<ProtocolIssuanceBatch>;
  markIssuancesFailed(input: { issuanceIds: string[]; errorCode: string; errorMessage: string; now: string }): Promise<void>;
  listBatchesReadyToCommit(input: { minBatchSize: number; maxBatchSize: number; maxBatchAgeSeconds: number; now: string }): Promise<BatchWithIssuances[]>;
  listBatchesByCheckpoint(input: { checkpoint: ProtocolIssuanceCheckpoint; limit: number }): Promise<BatchWithIssuances[]>;
  markBatchCommitted(input: MarkBatchCommittedInput): Promise<void>;
  markBatchProvingSubmitted(input: MarkBatchProvingSubmittedInput): Promise<void>;
  markBatchProvingComplete(input: MarkBatchProvingCompleteInput): Promise<void>;
  markBatchBroadcast(input: MarkBatchBroadcastInput): Promise<void>;
  markBatchPublished(input: MarkBatchPublishedInput): Promise<void>;
  markIssuancesIssued(input: { issuances: MarkIssuanceIssuedInput[]; now: string }): Promise<void>;
  recordBatchRetryableError(input: MarkBatchFailedInput): Promise<void>;
  markBatchFailed(input: MarkBatchFailedInput): Promise<void>;
};
