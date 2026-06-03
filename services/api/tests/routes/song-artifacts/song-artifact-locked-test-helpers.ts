import { app } from "../../../src/index"
import type { Client } from "@libsql/client"
import { json } from "../../helpers"
import { completeUniqueHumanVerification, requestJson } from "./song-artifact-test-helpers"
import type { Env } from "../../../src/types"

export function installLockedSongFetchMocks(input: {
  originalFetch: typeof fetch
  storedObjects: Map<string, { body: Uint8Array; contentType: string }>
}): void {
  globalThis.fetch = async (requestInput: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = requestInput instanceof Request ? requestInput : new Request(requestInput, init)

    if (request.url === "https://openrouter.test/api/v1/chat/completions") {
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                age_gate_rating: "safe",
                reason: "clean lyrics",
              }),
            },
          },
        ],
      })
    }

    if (request.url.endsWith("/moderations")) {
      return Response.json({
        results: [
          {
            categories: {},
            category_scores: {},
          },
        ],
      })
    }

    if (request.url === "https://acrcloud.test/v1/identify") {
      return Response.json({
        status: {
          code: 0,
          msg: "Success",
        },
        metadata: {
          music: [],
        },
      })
    }

    if (request.url === "https://elevenlabs.test/forced-alignment") {
      return Response.json({
        provider: "elevenlabs",
        segments: [
          {
            start_ms: 0,
            end_ms: 1200,
            text: "Paid line",
          },
        ],
      })
    }

    if (!request.url.startsWith("https://s3.filebase.test/")) {
      return await input.originalFetch(request)
    }

    if (request.method === "PUT") {
      input.storedObjects.set(request.url, {
        body: new Uint8Array(await request.arrayBuffer()),
        contentType: request.headers.get("content-type") || "application/octet-stream",
      })
      return new Response(null, {
        status: 200,
        headers: { "x-amz-meta-cid": "bafysongartifactcid" },
      })
    }

    if (request.method === "GET") {
      const stored = input.storedObjects.get(request.url)
      if (!stored) {
        return new Response("missing", { status: 404 })
      }
      const range = request.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/)
      if (range) {
        const start = Number(range[1])
        const requestedEnd = range[2] ? Number(range[2]) : stored.body.byteLength - 1
        const end = Math.min(requestedEnd, stored.body.byteLength - 1)
        const body = stored.body.slice(start, end + 1)
        return new Response(body.buffer, {
          status: 206,
          headers: {
            "accept-ranges": "bytes",
            "content-type": stored.contentType,
            "content-length": String(body.byteLength),
            "content-range": `bytes ${start}-${end}/${stored.body.byteLength}`,
          },
        })
      }
      return new Response(stored.body.slice().buffer, {
        status: 200,
        headers: {
          "accept-ranges": "bytes",
          "content-type": stored.contentType,
          "content-length": String(stored.body.byteLength),
        },
      })
    }

    return new Response("unexpected method", { status: 500 })
  }
}

export async function attachPrimaryWallet(input: {
  client: Client
  userId: string
  walletAttachmentId: string
  walletAddress: string
  attachedAt?: string
}): Promise<void> {
  const attachedAt = input.attachedAt ?? new Date().toISOString()
  await input.client.execute({
    sql: `
      INSERT INTO wallet_attachments (
        wallet_attachment_id, user_id, chain_namespace, wallet_address_normalized, wallet_address_display,
        source_provider, source_subject, attachment_kind, is_primary, status, attached_at, detached_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, 'eip155:1315', ?3, ?3,
        'test', ?2, 'external', 1, 'active', ?4, NULL, ?4, ?4
      )
    `,
    args: [input.walletAttachmentId, input.userId, input.walletAddress, attachedAt],
  })
  await input.client.execute({
    sql: `
      UPDATE users
      SET primary_wallet_attachment_id = ?2,
          updated_at = ?3
      WHERE user_id = ?1
    `,
    args: [input.userId, input.walletAttachmentId, attachedAt],
  })
}

export async function createOpenSongCommunity(env: Env, accessToken: string, displayName: string): Promise<string> {
  const communityCreate = await requestJson("http://pirate.test/communities", {
    display_name: displayName,
    membership_mode: "request",
    handle_policy: {
      policy_template: "standard",
    },
  }, env, accessToken)
  const communityCreateBody = await json(communityCreate) as {
    community: {
      id: string
    }
  }
  return communityCreateBody.community.id.replace(/^com_/, "")
}

export async function uploadSongArtifact(input: {
  env: Env
  communityId: string
  accessToken: string
  artifactKind: "primary_audio" | "primary_video" | "preview_video"
  mimeType: string
  filename: string
  bytes: Uint8Array
}): Promise<{
  id: string
  storage_ref: string
}> {
  const uploadBody = Uint8Array.from(input.bytes)
  const uploadIntent = await requestJson(
    `http://pirate.test/communities/${input.communityId}/song-artifact-uploads`,
    {
      artifact_kind: input.artifactKind,
      mime_type: input.mimeType,
      filename: input.filename,
      size_bytes: input.bytes.byteLength,
    },
    input.env,
    input.accessToken,
  )
  const uploadIntentBody = await json(uploadIntent) as {
    id: string
    storage_ref: string
  }

  await app.request(
    `http://pirate.test/communities/${input.communityId}/song-artifact-uploads/${uploadIntentBody.id}/content`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "content-type": input.mimeType,
      },
      body: new Blob([uploadBody.buffer], { type: input.mimeType }),
    },
    input.env,
  )

  return uploadIntentBody
}

export async function verifyAsHuman(env: Env, accessToken: string): Promise<void> {
  await completeUniqueHumanVerification(env, accessToken)
}
