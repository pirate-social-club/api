import { describe, expect, test } from "bun:test";
import { createRunPodProofClient } from "./runpod-proof-client.js";

describe("RunPod proof client", () => {
  test("submits async proof jobs with RunPod queue shape", async () => {
    const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
    const client = createRunPodProofClient({
      endpointId: "endpoint-test",
      apiKey: "key-test",
      fetch: (async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method ?? "GET",
          headers: init?.headers as Record<string, string>,
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return Response.json({ id: "job-test", status: "IN_QUEUE" });
      }) as typeof fetch,
    });

    await expect(client.submitProofJob({
      batchId: "pib_test",
      parentSpace: "@pesto",
      proofInputRef: "memory://proof",
      proofInputBase64: "proof-input",
    })).resolves.toEqual({
      jobId: "job-test",
      status: "IN_QUEUE",
    });
    expect(calls[0]).toEqual({
      url: "https://api.runpod.ai/v2/endpoint-test/run",
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: "Bearer key-test",
        "content-type": "application/json",
      },
      body: {
        input: {
          batch_id: "pib_test",
          parent_space: "@pesto",
          proof_input_ref: "memory://proof",
          proof_input_base64: "proof-input",
        },
      },
    });
  });

  test("maps completed, pending, and failed job statuses", async () => {
    const responses = [
      { status: "IN_PROGRESS" },
      { status: "COMPLETED", output: { fulfill_payload_base64: "fulfill" } },
      { status: "FAILED", error: "boom" },
    ];
    const client = createRunPodProofClient({
      endpointId: "endpoint-test",
      apiKey: "key-test",
      fetch: (async () => Response.json(responses.shift())) as typeof fetch,
    });

    await expect(client.getProofJobStatus({ jobId: "job-test" })).resolves.toEqual({
      status: "running",
      providerStatus: "IN_PROGRESS",
    });
    await expect(client.getProofJobStatus({ jobId: "job-test" })).resolves.toEqual({
      status: "completed",
      providerStatus: "COMPLETED",
      fulfillPayloadBase64: "fulfill",
    });
    await expect(client.getProofJobStatus({ jobId: "job-test" })).resolves.toEqual({
      status: "failed",
      providerStatus: "FAILED",
      errorMessage: "boom",
    });
  });
});
