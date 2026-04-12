import { afterEach, describe, expect, test } from "bun:test"
import type { Env } from "../src/types"
import {
  inspectSpacesNamespace,
  verifySpacesNamespaceSignature,
} from "../src/lib/verification/spaces-verifier"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function buildEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: "test",
    ...overrides,
  } as Env
}

describe("spaces verifier provider", () => {
  test("inspect normalizes a verifier base url ending in /inspect", async () => {
    let requestedUrl = ""
    globalThis.fetch = (async (input) => {
      requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      return new Response(JSON.stringify({
        root_exists: true,
        root_key_proof_verified: true,
        anchor_fresh_enough: true,
        accepted_anchor_height: 1,
        accepted_anchor_block_hash: "anchor-block",
        accepted_anchor_root_hash: "anchor-root",
        proof_root_hash: "proof-root",
        root_pubkey: "pubkey",
        control_class: "single_holder_root",
        operation_class: "owner_managed_namespace",
        observation_provider: "test-provider",
        evidence_bundle_ref: null,
        failure_reason: null,
        proof_payload: {
          proof: "value",
        },
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    }) as typeof globalThis.fetch

    const result = await inspectSpacesNamespace({
      env: buildEnv({
        SPACES_VERIFIER_BASE_URL: "https://spaces.test/inspect",
      }),
      normalizedRootLabel: "pirate",
    })

    expect(requestedUrl).toBe("https://spaces.test/inspect?root_label=pirate")
    expect(result.rootExists).toBe(true)
    expect(result.proofPayload).toBe(JSON.stringify({ proof: "value" }))
  })

  test("verify sends only the documented signature payload fields", async () => {
    let requestUrl = ""
    let requestBody: Record<string, unknown> | null = null
    globalThis.fetch = (async (input, init) => {
      requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      requestBody = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>
      return new Response(JSON.stringify({
        valid_signature: true,
        wrong_signer: false,
        observation_provider: "test-provider",
        failure_reason: null,
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      })
    }) as typeof globalThis.fetch

    const result = await verifySpacesNamespaceSignature({
      env: buildEnv({
        SPACES_VERIFIER_BASE_URL: "https://spaces.test/verify-signature",
      }),
      normalizedRootLabel: "pirate",
      digest: "d".repeat(64),
      signature: "s".repeat(128),
      rootPubkey: "p".repeat(64),
      signerPubkey: "q".repeat(64),
      algorithm: "bip340_schnorr",
    })

    expect(requestUrl).toBe("https://spaces.test/verify-signature")
    expect(requestBody).toEqual({
      digest: "d".repeat(64),
      signature: "s".repeat(128),
      root_pubkey: "p".repeat(64),
      signer_pubkey: "q".repeat(64),
      algorithm: "bip340_schnorr",
    })
    expect(result.validSignature).toBe(true)
  })

  test("stub mode is rejected outside local environments", async () => {
    await expect(inspectSpacesNamespace({
      env: buildEnv({
        ENVIRONMENT: "production",
        ALLOW_STUB_NAMESPACE_VERIFICATION: "true",
      }),
      normalizedRootLabel: "pirate",
    })).rejects.toMatchObject({
      status: 500,
      code: "internal_error",
    })
  })
})
