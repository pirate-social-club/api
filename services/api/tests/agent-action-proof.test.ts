import { generateKeyPairSync, sign as signWithPrivateKey } from "node:crypto"
import { describe, expect, test } from "bun:test"
import {
  canonicalizeAgentActionProofRequest,
  canonicalizeAgentActionProofSignaturePayload,
  computeAgentActionProofHash,
  getAgentActionProofCanonicalVersion,
  verifyAgentActionProofSignature,
} from "../src/lib/agents/agent-action-proof"

describe("agent action proof canonicalization", () => {
  test("canonicalizes method path query and sorted JSON body deterministically", async () => {
    const canonical = canonicalizeAgentActionProofRequest({
      method: "post",
      url: "http://pirate.test/communities/cmt_123/posts?sort=new&draft=false",
      body: {
        title: "Agent post",
        post_type: "text",
        body: "Hello",
      },
    })

    expect(canonical).toBe([
      getAgentActionProofCanonicalVersion(),
      "POST",
      "http://pirate.test",
      "/communities/cmt_123/posts",
      "draft=false&sort=new",
      '{"body":"Hello","post_type":"text","title":"Agent post"}',
    ].join("\n"))

    const hash = await computeAgentActionProofHash({
      method: "post",
      url: "http://pirate.test/communities/cmt_123/posts?sort=new&draft=false",
      body: {
        title: "Agent post",
        post_type: "text",
        body: "Hello",
      },
    })
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  test("uses the empty string for absent or empty bodies", () => {
    const absent = canonicalizeAgentActionProofRequest({
      method: "POST",
      url: "http://pirate.test/communities/cmt_123/posts",
    })
    const empty = canonicalizeAgentActionProofRequest({
      method: "POST",
      url: "http://pirate.test/communities/cmt_123/posts",
      body: "",
    })

    expect(absent).toBe([
      getAgentActionProofCanonicalVersion(),
      "POST",
      "http://pirate.test",
      "/communities/cmt_123/posts",
      "",
      "",
    ].join("\n"))
    expect(empty).toBe(absent)
  })

  test("sorts duplicate query keys by value and trims trailing slashes from non-root paths", () => {
    const canonical = canonicalizeAgentActionProofRequest({
      method: "delete",
      url: "http://pirate.test/agents/agt_123///?filter=z&filter=a&mode=fast",
      body: null,
    })

    expect(canonical).toBe([
      getAgentActionProofCanonicalVersion(),
      "DELETE",
      "http://pirate.test",
      "/agents/agt_123",
      "filter=a&filter=z&mode=fast",
      "",
    ].join("\n"))
  })

  test("sorts nested JSON object keys recursively while preserving array order", () => {
    const canonical = canonicalizeAgentActionProofRequest({
      method: "POST",
      url: "http://pirate.test/example",
      body: {
        outer_b: {
          z: 2,
          a: 1,
        },
        outer_a: [
          { y: 2, x: 1 },
          3,
        ],
      },
    })

    expect(canonical.split("\n")[5]).toBe('{"outer_a":[{"x":1,"y":2},3],"outer_b":{"a":1,"z":2}}')
  })

  test("sorts query params and JSON object keys by UTF-8 byte order", () => {
    const canonical = canonicalizeAgentActionProofRequest({
      method: "POST",
      url: "http://pirate.test/example?%C3%A4=1&z=1",
      body: {
        ä_key: 2,
        z_key: 1,
      },
    })

    expect(canonical).toBe([
      getAgentActionProofCanonicalVersion(),
      "POST",
      "http://pirate.test",
      "/example",
      "z=1&%C3%A4=1",
      '{"z_key":1,"ä_key":2}',
    ].join("\n"))
  })

  test("binds the canonical request hash to the request origin", async () => {
    const httpHash = await computeAgentActionProofHash({
      method: "POST",
      url: "http://pirate.test/example",
      body: { hello: "world" },
    })
    const httpsHash = await computeAgentActionProofHash({
      method: "POST",
      url: "https://pirate.test/example",
      body: { hello: "world" },
    })

    expect(httpHash).not.toBe(httpsHash)
  })

  test("rejects circular JSON bodies", () => {
    const body: Record<string, unknown> = { title: "loop" }
    body.self = body

    expect(() => canonicalizeAgentActionProofRequest({
      method: "POST",
      url: "http://pirate.test/example",
      body,
    })).toThrow(/cannot contain circular references/)
  })

  test("verifies a v0 Ed25519 signature against the canonical proof payload", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519")
    const proof = {
      nonce: "nonce-1",
      signed_at: "2026-04-19T12:00:00.000Z",
      canonical_request_hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      signature: "",
    }

    proof.signature = signWithPrivateKey(
      null,
      Buffer.from(canonicalizeAgentActionProofSignaturePayload({
        nonce: proof.nonce,
        signedAt: proof.signed_at,
        canonicalRequestHash: proof.canonical_request_hash,
      }), "utf8"),
      privateKey,
    ).toString("base64")

    expect(verifyAgentActionProofSignature({
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
      proof,
    })).toBe(true)
  })
})
