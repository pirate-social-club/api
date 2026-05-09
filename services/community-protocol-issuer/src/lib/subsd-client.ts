export type SubsdStageResult =
  | { status: "staged" }
  | { status: "already_staged" }
  | { status: "already_committed" }
  | { status: "script_pubkey_conflict"; reason: "already_staged_different_spk" | "already_committed_different_spk" };

export type SubsdCommitResult = {
  rootBefore: string | null;
  rootAfter: string | null;
  proofRequired: boolean;
};

export type SubsdBroadcastResult = {
  bitcoinTxid: string | null;
  commitRef: string | null;
};

export type SubsdCommitStatusResult = {
  finalized: boolean;
  confirmations: number | null;
};

export type SubsdCertificateResult = {
  sname: string;
  certificatePayload: unknown;
  certificateRef: string | null;
};

export type SubsdPublishResult = {
  fabricSubmissionRef: string | null;
};

export type SubsdProvingRequestResult = {
  requestBase64: string | null;
};

export type SubsdFulfillProofResult = {
  success: boolean;
  message: string | null;
};

export type SubsdClient = {
  stageRequest(input: { parentSpace: string; sname: string; scriptPubkeyHex: string }): Promise<SubsdStageResult>;
  commitLocal(input: { parentSpace: string }): Promise<SubsdCommitResult>;
  getNextProvingRequest(input: { parentSpace: string }): Promise<SubsdProvingRequestResult>;
  fulfillProvingRequest(input: { parentSpace: string; fulfillPayloadBase64: string }): Promise<SubsdFulfillProofResult>;
  broadcastCommit(input: { parentSpace: string; feeRateSatVb?: number }): Promise<SubsdBroadcastResult>;
  getCommitStatus(input: { parentSpace: string }): Promise<SubsdCommitStatusResult>;
  getCertificate(input: { sname: string }): Promise<SubsdCertificateResult>;
  publishCertificates(input: { parentSpace: string; certificates: SubsdCertificateResult[] }): Promise<SubsdPublishResult>;
};

type SubsdStageResponse = {
  by_space?: Array<{
    added?: unknown[];
    skipped?: Array<{
      reason?: string;
    }>;
  }>;
  total_added?: number;
};

type SubsdCommitResponse = {
  prev_root?: string | null;
  root?: string | null;
  is_initial?: boolean;
};

type SubsdBroadcastResponse = {
  bitcoin_txid?: string | null;
  txid?: string | null;
  commit_ref?: string | null;
};

type SubsdCommitStatusResponse = {
  status?: string;
  txid?: string | null;
  block_height?: number | null;
  confirmations?: number | null;
};

type SubsdCertificateResponse = {
  root_cert?: string;
  handle_cert?: string | null;
};

type SubsdPublishResponse = {
  handles_published?: number;
  remaining?: number;
};

type SubsdFulfillResponse = {
  success?: boolean;
  message?: string | null;
};

export class SubsdHttpError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(message: string, status: number, body: string) {
    super(`${message}: ${status}${body ? ` ${body}` : ""}`);
    this.name = "SubsdHttpError";
    this.status = status;
    this.body = body;
  }
}

export class UnknownSubsdStageOutcomeError extends Error {
  readonly outcome: string;

  constructor(outcome: string) {
    super(`Unknown subsd stage outcome: ${outcome}`);
    this.name = "UnknownSubsdStageOutcomeError";
    this.outcome = outcome;
  }
}

function normalizeSubsdOutcome(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeStageResponse(body: SubsdStageResponse): SubsdStageResult {
  if ((body.total_added ?? 0) > 0) {
    return { status: "staged" };
  }
  const skipped = body.by_space?.flatMap((space) => space.skipped ?? []) ?? [];
  const outcome = normalizeSubsdOutcome(skipped[0]?.reason);
  if (!outcome) {
    return { status: "staged" };
  }
  if (outcome === "alreadystaged" || outcome === "already_staged") {
    return { status: "already_staged" };
  }
  if (outcome === "alreadycommitted" || outcome === "already_committed") {
    return { status: "already_committed" };
  }
  if (outcome === "alreadystageddifferentspk" || outcome === "already_staged_different_spk") {
    return { status: "script_pubkey_conflict", reason: "already_staged_different_spk" };
  }
  if (outcome === "alreadycommitteddifferentspk" || outcome === "already_committed_different_spk") {
    return { status: "script_pubkey_conflict", reason: "already_committed_different_spk" };
  }
  throw new UnknownSubsdStageOutcomeError(outcome);
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new SubsdHttpError("subsd request failed", response.status, text);
  }
  return (text.trim() ? JSON.parse(text) : {}) as T;
}

async function parseBinaryResponse(response: Response): Promise<Uint8Array> {
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!response.ok) {
    const body = new TextDecoder().decode(bytes);
    throw new SubsdHttpError("subsd request failed", response.status, body);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

export function createSubsdHttpClient(input: {
  baseUrl: string;
  fetch?: typeof fetch;
}): SubsdClient {
  const baseUrl = input.baseUrl.replace(/\/+$/u, "");
  const fetchFn = input.fetch ?? fetch;

  return {
    async stageRequest(request) {
      const body = await parseJsonResponse<SubsdStageResponse>(await fetchFn(`${baseUrl}/requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              handle: request.sname,
              script_pubkey: request.scriptPubkeyHex,
            },
          ],
        }),
      }));
      return normalizeStageResponse(body);
    },
    async commitLocal(request) {
      // This endpoint performs subsd's local Merkle commit step. Bitcoin broadcast is a later
      // workflow checkpoint and is intentionally not triggered by this client method.
      const body = await parseJsonResponse<SubsdCommitResponse>(await fetchFn(
        `${baseUrl}/spaces/${encodeURIComponent(request.parentSpace)}/commit`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      ));
      const proofRequired = typeof body.is_initial === "boolean"
        ? !body.is_initial
        : body.prev_root !== null && body.prev_root !== undefined;
      return {
        rootBefore: body.prev_root ?? null,
        rootAfter: body.root ?? null,
        // Current subsd exposes `is_initial`; older test-rig builds only exposed `prev_root`.
        // Initial commits do not require proving. Non-initial commits do.
        proofRequired,
      };
    },
    async getNextProvingRequest(request) {
      const bytes = await parseBinaryResponse(await fetchFn(
        `${baseUrl}/spaces/${encodeURIComponent(request.parentSpace)}/proving/next`,
        { method: "GET" },
      ));
      // subsd serializes Option<ProvingRequest>; the prover expects the inner
      // ProvingRequest bytes, so strip the Borsh Some tag.
      if (bytes.length > 0 && bytes[0] !== 0 && bytes[0] !== 1) {
        throw new Error(`Unexpected subsd proving request option tag: ${bytes[0]}`);
      }
      return {
        requestBase64: bytes.length === 0 || bytes[0] === 0 ? null : bytesToBase64(bytes.slice(1)),
      };
    },
    async fulfillProvingRequest(request) {
      const body = await parseJsonResponse<SubsdFulfillResponse>(await fetchFn(
        `${baseUrl}/spaces/${encodeURIComponent(request.parentSpace)}/proving/fulfill`,
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: base64ToArrayBuffer(request.fulfillPayloadBase64),
        },
      ));
      return {
        success: body.success === true,
        message: typeof body.message === "string" ? body.message : null,
      };
    },
    async broadcastCommit(request) {
      const body = await parseJsonResponse<SubsdBroadcastResponse>(await fetchFn(
        `${baseUrl}/spaces/${encodeURIComponent(request.parentSpace)}/broadcast`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(request.feeRateSatVb === undefined ? {} : { fee_rate: request.feeRateSatVb }),
          }),
        },
      ));
      return {
        bitcoinTxid: body.bitcoin_txid ?? body.txid ?? null,
        commitRef: body.commit_ref ?? body.bitcoin_txid ?? body.txid ?? null,
      };
    },
    async getCommitStatus(request) {
      const body = await parseJsonResponse<SubsdCommitStatusResponse>(await fetchFn(
        `${baseUrl}/spaces/${encodeURIComponent(request.parentSpace)}/commit/status`,
        { method: "GET" },
      ));
      return {
        finalized: body.status === "finalized",
        confirmations: typeof body.confirmations === "number" ? body.confirmations : null,
      };
    },
    async getCertificate(request) {
      const body = await parseJsonResponse<SubsdCertificateResponse>(await fetchFn(
        `${baseUrl}/certs/${encodeURIComponent(request.sname)}`,
        { method: "GET" },
      ));
      return {
        sname: request.sname,
        certificatePayload: body,
        certificateRef: body.handle_cert ?? body.root_cert ?? null,
      };
    },
    async publishCertificates(request) {
      const body = await parseJsonResponse<SubsdPublishResponse>(await fetchFn(
        `${baseUrl}/spaces/${encodeURIComponent(request.parentSpace)}/publish`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            handles: request.certificates.map((certificate) => certificate.sname.split("@")[0]),
          }),
        },
      ));
      return {
        fabricSubmissionRef: body.handles_published === undefined
          ? null
          : `published:${body.handles_published}:remaining:${body.remaining ?? 0}`,
      };
    },
  };
}
