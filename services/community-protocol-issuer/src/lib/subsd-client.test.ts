import { describe, expect, test } from "bun:test";
import { UnknownSubsdStageOutcomeError, createSubsdHttpClient, normalizeStageResponse } from "./subsd-client.js";

describe("subsd client helpers", () => {
  test("normalizes idempotent stage outcomes", () => {
    expect(normalizeStageResponse({ by_space: [{ skipped: [{ reason: "AlreadyStaged" }] }], total_added: 0 })).toEqual({ status: "already_staged" });
    expect(normalizeStageResponse({ by_space: [{ skipped: [{ reason: "AlreadyCommitted" }] }], total_added: 0 })).toEqual({ status: "already_committed" });
  });

  test("normalizes script pubkey conflicts", () => {
    expect(normalizeStageResponse({ by_space: [{ skipped: [{ reason: "AlreadyStagedDifferentSpk" }] }], total_added: 0 })).toEqual({
      status: "script_pubkey_conflict",
      reason: "already_staged_different_spk",
    });
    expect(normalizeStageResponse({ by_space: [{ skipped: [{ reason: "AlreadyCommittedDifferentSpk" }] }], total_added: 0 })).toEqual({
      status: "script_pubkey_conflict",
      reason: "already_committed_different_spk",
    });
  });

  test("rejects unknown stage outcomes", () => {
    expect(() => normalizeStageResponse({ by_space: [{ skipped: [{ reason: "SurpriseOutcome" }] }], total_added: 0 })).toThrow(UnknownSubsdStageOutcomeError);
  });

  test("calls upstream request and commit shapes", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const client = createSubsdHttpClient({
      baseUrl: "http://subsd.test",
      fetch: (async (input, init) => {
        const url = String(input);
        calls.push({
          url,
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        if (url.endsWith("/requests")) {
          return Response.json({ by_space: [{ added: ["ice@pesto"], skipped: [] }], total_added: 1 });
        }
        if (url.endsWith("/commit")) {
          return Response.json({ space: "@pesto", prev_root: "root-before", root: "root-after", handles_committed: 1, is_initial: false });
        }
        return Response.json({});
      }) as typeof fetch,
    });

    await expect(client.stageRequest({
      parentSpace: "@pesto",
      sname: "ice@pesto",
      scriptPubkeyHex: "5120a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c",
    })).resolves.toEqual({ status: "staged" });
    await expect(client.commitLocal({ parentSpace: "@pesto" })).resolves.toEqual({
      rootBefore: "root-before",
      rootAfter: "root-after",
      proofRequired: true,
    });

    expect(calls[0]).toEqual({
      method: "POST",
      url: "http://subsd.test/requests",
      body: {
        requests: [{
          handle: "ice@pesto",
          script_pubkey: "5120a60869f0dbcf1dc659c9cecbaf8050135ea9e8cdc487053f1dc6880949dc684c",
        }],
      },
    });
    expect(calls[1]).toEqual({
      method: "POST",
      url: "http://subsd.test/spaces/%40pesto/commit",
      body: {},
    });
  });

  test("uses subsd is_initial as the canonical proof-required signal when present", async () => {
    const client = createSubsdHttpClient({
      baseUrl: "http://subsd.test",
      fetch: (async () => Response.json({
        prev_root: "root-before",
        root: "root-after",
        is_initial: true,
      })) as typeof fetch,
    });

    await expect(client.commitLocal({ parentSpace: "@pesto" })).resolves.toEqual({
      rootBefore: "root-before",
      rootAfter: "root-after",
      proofRequired: false,
    });
  });

  test("falls back to prev_root for older subsd commit responses", async () => {
    const client = createSubsdHttpClient({
      baseUrl: "http://subsd.test",
      fetch: (async () => Response.json({
        prev_root: "root-before",
        root: "root-after",
      })) as typeof fetch,
    });

    await expect(client.commitLocal({ parentSpace: "@pesto" })).resolves.toEqual({
      rootBefore: "root-before",
      rootAfter: "root-after",
      proofRequired: true,
    });
  });

  test("calls proofless publish pipeline endpoints", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const client = createSubsdHttpClient({
      baseUrl: "http://subsd.test",
      fetch: (async (input, init) => {
        const url = String(input);
        calls.push({
          url,
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        if (url.endsWith("/broadcast")) {
          return Response.json({ bitcoin_txid: "tx-test" });
        }
        if (url.endsWith("/commit/status")) {
          return Response.json({ status: "finalized", confirmations: 150 });
        }
        if (url.includes("/certs/")) {
          return Response.json({ root_cert: "root-cert-test", handle_cert: "handle-cert-test" });
        }
        if (url.endsWith("/publish")) {
          return Response.json({ handles_published: 1, remaining: 0 });
        }
        return Response.json({});
      }) as typeof fetch,
    });

    await expect(client.broadcastCommit({ parentSpace: "@pesto", feeRateSatVb: 2 })).resolves.toEqual({
      bitcoinTxid: "tx-test",
      commitRef: "tx-test",
    });
    await expect(client.getCommitStatus({ parentSpace: "@pesto" })).resolves.toEqual({
      finalized: true,
      confirmations: 150,
    });
    const certificate = await client.getCertificate({ sname: "ice@pesto" });
    expect(certificate).toEqual({
      sname: "ice@pesto",
      certificatePayload: { root_cert: "root-cert-test", handle_cert: "handle-cert-test" },
      certificateRef: "handle-cert-test",
    });
    await expect(client.publishCertificates({ parentSpace: "@pesto", certificates: [certificate] })).resolves.toEqual({
      fabricSubmissionRef: "published:1:remaining:0",
    });

    expect(calls.map((call) => [call.method, call.url])).toEqual([
      ["POST", "http://subsd.test/spaces/%40pesto/broadcast"],
      ["GET", "http://subsd.test/spaces/%40pesto/commit/status"],
      ["GET", "http://subsd.test/certs/ice%40pesto"],
      ["POST", "http://subsd.test/spaces/%40pesto/publish"],
    ]);
    expect(calls[0]?.body).toEqual({ fee_rate: 2 });
    expect(calls[3]?.body).toEqual({ handles: ["ice"] });
  });

  test("calls proving request and fulfill endpoints", async () => {
    const calls: Array<{ url: string; method: string; body: string | null }> = [];
    const client = createSubsdHttpClient({
      baseUrl: "http://subsd.test",
      fetch: (async (input, init) => {
        const url = String(input);
        const body = init?.body instanceof ArrayBuffer
          ? Array.from(new Uint8Array(init.body)).join(",")
          : null;
        calls.push({
          url,
          method: init?.method ?? "GET",
          body,
        });
        if (url.endsWith("/proving/next")) {
          return new Response(new Uint8Array([1, 10, 20, 30]));
        }
        if (url.endsWith("/proving/fulfill")) {
          return Response.json({ success: true, message: null });
        }
        return Response.json({});
      }) as typeof fetch,
    });

    await expect(client.getNextProvingRequest({ parentSpace: "@pesto" })).resolves.toEqual({
      requestBase64: "ChQe",
    });
    await expect(client.fulfillProvingRequest({
      parentSpace: "@pesto",
      fulfillPayloadBase64: "AQID",
    })).resolves.toEqual({
      success: true,
      message: null,
    });
    expect(calls).toEqual([
      {
        method: "GET",
        url: "http://subsd.test/spaces/%40pesto/proving/next",
        body: null,
      },
      {
        method: "POST",
        url: "http://subsd.test/spaces/%40pesto/proving/fulfill",
        body: "1,2,3",
      },
    ]);
  });

  test("treats empty proving option as no pending proof", async () => {
    const client = createSubsdHttpClient({
      baseUrl: "http://subsd.test",
      fetch: (async () => new Response(new Uint8Array([0]))) as typeof fetch,
    });
    await expect(client.getNextProvingRequest({ parentSpace: "@pesto" })).resolves.toEqual({
      requestBase64: null,
    });
  });

  test("rejects unexpected proving option tags", async () => {
    const client = createSubsdHttpClient({
      baseUrl: "http://subsd.test",
      fetch: (async () => new Response(new Uint8Array([2, 10]))) as typeof fetch,
    });
    await expect(client.getNextProvingRequest({ parentSpace: "@pesto" }))
      .rejects.toThrow("Unexpected subsd proving request option tag: 2");
  });
});
