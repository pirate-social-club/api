export type ProofJobSubmitResult = {
  jobId: string;
  status: string;
};

export type ProofJobStatusResult =
  | { status: "queued" | "running"; providerStatus: string }
  | { status: "completed"; providerStatus: string; fulfillPayloadBase64: string }
  | { status: "failed"; providerStatus: string; errorMessage: string };

export type ProofJobClient = {
  submitProofJob(input: {
    batchId: string;
    parentSpace: string;
    proofInputRef: string;
    proofInputBase64: string;
  }): Promise<ProofJobSubmitResult>;
  getProofJobStatus(input: {
    jobId: string;
  }): Promise<ProofJobStatusResult>;
};

type RunPodSubmitResponse = {
  id?: string;
  status?: string;
};

type RunPodStatusResponse = {
  id?: string;
  status?: string;
  output?: unknown;
  error?: string;
};

function stringField(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const field = record[key];
    if (typeof field === "string" && field.trim()) {
      return field;
    }
  }
  return null;
}

function normalizeRunPodStatus(status: string | undefined): string {
  return String(status ?? "").trim().toUpperCase();
}

async function parseRunPodJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`RunPod request failed: ${response.status}${text ? ` ${text}` : ""}`);
  }
  return (text.trim() ? JSON.parse(text) : {}) as T;
}

export function createRunPodProofClient(input: {
  endpointId: string;
  apiKey: string;
  fetch?: typeof fetch;
}): ProofJobClient {
  const fetchFn = input.fetch ?? fetch;
  const baseUrl = `https://api.runpod.ai/v2/${encodeURIComponent(input.endpointId)}`;
  const authorization = input.apiKey.trim().startsWith("Bearer ")
    ? input.apiKey.trim()
    : `Bearer ${input.apiKey.trim()}`;

  return {
    async submitProofJob(job) {
      const body = await parseRunPodJson<RunPodSubmitResponse>(await fetchFn(`${baseUrl}/run`, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          input: {
            batch_id: job.batchId,
            parent_space: job.parentSpace,
            proof_input_ref: job.proofInputRef,
            proof_input_base64: job.proofInputBase64,
          },
        }),
      }));
      if (!body.id) {
        throw new Error("RunPod /run response did not include a job id");
      }
      return {
        jobId: body.id,
        status: body.status ?? "UNKNOWN",
      };
    },

    async getProofJobStatus(job) {
      const body = await parseRunPodJson<RunPodStatusResponse>(await fetchFn(`${baseUrl}/status/${encodeURIComponent(job.jobId)}`, {
        method: "GET",
        headers: {
          authorization,
        },
      }));
      const providerStatus = body.status ?? "UNKNOWN";
      switch (normalizeRunPodStatus(body.status)) {
        case "IN_QUEUE":
        case "RETRYING":
          return { status: "queued", providerStatus };
        case "IN_PROGRESS":
          return { status: "running", providerStatus };
        case "COMPLETED": {
          const fulfillPayloadBase64 = stringField(body.output, [
            "fulfill_payload_base64",
            "fulfillPayloadBase64",
            "proof_receipt_payload_base64",
          ]);
          if (!fulfillPayloadBase64) {
            return {
              status: "failed",
              providerStatus,
              errorMessage: "RunPod completed without fulfill payload",
            };
          }
          return { status: "completed", providerStatus, fulfillPayloadBase64 };
        }
        case "FAILED":
        case "TIMED_OUT":
        case "CANCELLED":
          return {
            status: "failed",
            providerStatus,
            errorMessage: body.error ?? `RunPod job ${providerStatus}`,
          };
        default:
          return { status: "running", providerStatus };
      }
    },
  };
}
