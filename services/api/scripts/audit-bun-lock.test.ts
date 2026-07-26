import { describe, expect, test } from "bun:test";

import {
  evaluateFindings,
  extractRegistryPackages,
  queryBulkAdvisories,
} from "./audit-bun-lock";

const INTEGRITY = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

describe("bun.lock dependency advisory audit", () => {
  test("uses published identities, deduplicates versions, and excludes non-registry sources", () => {
    const packages = extractRegistryPackages({
      packages: {
        "@anon-aadhaar/core": [
          "@selfxyz/anon-aadhaar-core@0.0.1",
          "",
          {},
          INTEGRITY,
        ],
        "@scope/duplicate": ["@scope/duplicate@2.0.0", "", {}, INTEGRITY],
        "@scope/duplicate/peer": ["@scope/duplicate@2.0.0", [], {}, INTEGRITY],
        "duplicate/older": ["duplicate@1.0.0", "", {}, INTEGRITY],
        duplicate: ["duplicate@2.0.0", "", {}, INTEGRITY],
        local: ["local@file:../local", {}],
        github: ["github@github:owner/repo#commit", {}, "owner-repo-commit", INTEGRITY],
      },
    });

    expect(Object.fromEntries(packages)).toEqual({
      "@scope/duplicate": ["2.0.0"],
      "@selfxyz/anon-aadhaar-core": ["0.0.1"],
      duplicate: ["1.0.0", "2.0.0"],
    });
  });

  test("fails closed for an unrecognized package source", () => {
    expect(() =>
      extractRegistryPackages({
        packages: {
          suspicious: ["suspicious@https://example.com/archive.tgz", "", {}, INTEGRITY],
        },
      }),
    ).toThrow("unsupported registry package specifier");
  });

  test("submits deterministic bounded batches and normalizes advisories", async () => {
    const requests: Array<Record<string, string[]>> = [];
    const fetchImpl: typeof fetch = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)));
        return Response.json(
          requests.length === 1
            ? {
                alpha: [
                  {
                    severity: "high",
                    title: "Alpha advisory",
                    url: "https://github.com/advisories/GHSA-35JH-R3H4-6JHM",
                  },
                ],
              }
            : {},
        );
      },
      { preconnect: fetch.preconnect },
    );

    const findings = await queryBulkAdvisories(
      new Map([
        ["alpha", ["1.0.0"]],
        ["bravo", ["2.0.0"]],
        ["charlie", ["3.0.0"]],
      ]),
      { batchSize: 2, fetchImpl },
    );

    expect(requests).toEqual([
      { alpha: ["1.0.0"], bravo: ["2.0.0"] },
      { charlie: ["3.0.0"] },
    ]);
    expect(findings).toEqual([
      {
        ghsa: "GHSA-35JH-R3H4-6JHM",
        package: "alpha",
        severity: "high",
        title: "Alpha advisory",
        url: "https://github.com/advisories/GHSA-35JH-R3H4-6JHM",
      },
    ]);
  });

  test("fails closed on HTTP, JSON, schema, and partial-batch errors", async () => {
    const packages = new Map([["alpha", ["1.0.0"]]]);
    const asFetch = (handler: () => Promise<Response>): typeof fetch =>
      Object.assign(handler, { preconnect: fetch.preconnect }) as typeof fetch;

    await expect(
      queryBulkAdvisories(packages, {
        fetchImpl: asFetch(async () => new Response("unavailable", { status: 503 })),
      }),
    ).rejects.toThrow("HTTP 503");
    await expect(
      queryBulkAdvisories(packages, {
        fetchImpl: asFetch(async () => new Response("not-json")),
      }),
    ).rejects.toThrow("invalid JSON");
    await expect(
      queryBulkAdvisories(packages, {
        fetchImpl: asFetch(async () => Response.json({ alpha: "not-an-array" })),
      }),
    ).rejects.toThrow("must be an array");
    await expect(
      queryBulkAdvisories(packages, {
        fetchImpl: asFetch(async () => Response.json({ unrequested: [] })),
      }),
    ).rejects.toThrow("unrequested package");
  });

  test("preserves scheduled exception expiry semantics", () => {
    const findings = [
      {
        ghsa: "GHSA-35JH-R3H4-6JHM",
        package: "lodash",
        severity: "high",
        title: "Prototype pollution",
        url: "https://github.com/advisories/GHSA-35JH-R3H4-6JHM",
      },
    ];
    const baseline = {
      exceptions: [
        {
          advisory: "GHSA-35JH-R3H4-6JHM",
          expires: "2026-08-05T23:59:59Z",
          reason: "tracked temporary exception",
        },
      ],
    };

    expect(evaluateFindings(findings, baseline, "scheduled", new Date("2026-07-26T00:00:00Z"))).toMatchObject({
      accepted: [{ ghsa: "GHSA-35JH-R3H4-6JHM" }],
      blocking: [],
      expired: [],
    });
    expect(evaluateFindings(findings, baseline, "scheduled", new Date("2026-08-06T00:00:00Z"))).toMatchObject({
      accepted: [],
      blocking: [{ ghsa: "GHSA-35JH-R3H4-6JHM" }],
      expired: [{ advisory: "GHSA-35JH-R3H4-6JHM" }],
    });
  });
});
