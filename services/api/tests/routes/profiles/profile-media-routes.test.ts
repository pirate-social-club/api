import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../../../src/index"
import { createRouteTestContext, json, mintUpstreamJwt, resetRuntimeCaches } from "../../helpers"
import type { Env } from "../../../src/types"

let cleanup: (() => Promise<void>) | null = null
let originalFetch: typeof fetch

function toBodyBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

async function exchangeJwt(env: Env, sub: string): Promise<{ accessToken: string; userId: string }> {
  const jwt = await mintUpstreamJwt(env, { sub })
  const response = await app.request(
    "http://pirate.test/auth/session/exchange",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        proof: {
          type: "jwt_based_auth",
          jwt,
        },
      }),
    },
    env,
  )
  const body = await json(response) as { access_token: string; user: { user_id: string } }
  return { accessToken: body.access_token, userId: body.user.user_id }
}

beforeEach(() => {
  resetRuntimeCaches()
  originalFetch = globalThis.fetch
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("profile media routes", () => {
  test("uploads cover media to Filebase and serves it back through the public route", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (!request.url.startsWith("https://s3.filebase.test/")) {
        return await originalFetch(request)
      }

      if (request.method === "PUT") {
        const body = new Uint8Array(await request.arrayBuffer())
        storedObjects.set(request.url, {
          body,
          contentType: request.headers.get("content-type") || "application/octet-stream",
        })
        return new Response(null, {
          status: 200,
          headers: { "x-amz-meta-cid": "bafyprofilecovercid" },
        })
      }

      if (request.method === "GET") {
        const stored = storedObjects.get(request.url)
        if (!stored) {
          return new Response("missing", { status: 404 })
        }

        return new Response(toBodyBuffer(stored.body), {
          status: 200,
          headers: {
            "content-type": stored.contentType,
            "content-length": String(stored.body.byteLength),
          },
        })
      }

      return new Response("unexpected method", { status: 500 })
    }

    const ctx = await createRouteTestContext({
      FILEBASE_S3_ACCESS_KEY: "test-filebase-access",
      FILEBASE_S3_SECRET_KEY: "test-filebase-secret",
      FILEBASE_S3_ENDPOINT: "https://s3.filebase.test",
      FILEBASE_MEDIA_BUCKET: "pirate-media",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "profile-media-user")
    const fileBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 9, 9, 4])
    const formData = new FormData()
    formData.set("kind", "cover")
    formData.set("file", new File([fileBytes], "cover.png", { type: "image/png" }))

    const uploadResponse = await app.request(
      "http://pirate.test/profile-media",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
        body: formData,
      },
      ctx.env,
    )

    expect(uploadResponse.status).toBe(201)
    const uploadBody = await json(uploadResponse) as {
      kind: string
      media_ref: string
      mime_type: string
      size_bytes: number
      storage_bucket: string
      storage_object_key: string
    }
    expect(uploadBody.kind).toBe("cover")
    expect(uploadBody.media_ref).toBe("https://psc.myfilebase.com/ipfs/bafyprofilecovercid")
    expect((uploadBody as { ipfs_cid?: string }).ipfs_cid).toBe("bafyprofilecovercid")
    expect(uploadBody.storage_object_key).toMatch(/^profile-media\/cover\/cover_[a-z0-9]+\.png$/)

    const objectName = uploadBody.storage_object_key.split("/").pop() ?? ""
    const readResponse = await app.request(`http://pirate.test/profile-media/cover/${objectName}`, {}, ctx.env)
    expect(readResponse.status).toBe(200)
    expect(readResponse.headers.get("content-type")).toBe("image/png")
    const readBytes = new Uint8Array(await readResponse.arrayBuffer())
    expect([...readBytes]).toEqual([...fileBytes])
  })

  test("rejects unsupported media types before any bucket write", async () => {
    let filebaseCalled = false
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.url.startsWith("https://s3.filebase.test/")) {
        filebaseCalled = true
        return new Response(null, { status: 200 })
      }
      return await originalFetch(request)
    }

    const ctx = await createRouteTestContext({
      FILEBASE_S3_ACCESS_KEY: "test-filebase-access",
      FILEBASE_S3_SECRET_KEY: "test-filebase-secret",
      FILEBASE_S3_ENDPOINT: "https://s3.filebase.test",
      FILEBASE_MEDIA_BUCKET: "pirate-media",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "profile-media-invalid")
    const formData = new FormData()
    formData.set("kind", "avatar")
    formData.set("file", new File(["plain text"], "avatar.txt", { type: "text/plain" }))

    const response = await app.request(
      "http://pirate.test/profile-media",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
        body: formData,
      },
      ctx.env,
    )

    expect(response.status).toBe(400)
    const body = await json(response) as { code: string; message: string }
    expect(body.code).toBe("bad_request")
    expect(body.message).toBe("avatar must be a JPEG, PNG, WebP, GIF, or AVIF image")
    expect(filebaseCalled).toBe(false)
  })
})
