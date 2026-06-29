import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../../src/index"
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

describe("community media routes", () => {
  test("uploads avatar media to Filebase and serves it back through the public route", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    ;(globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }).fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (!request.url.startsWith("https://s3.filebase.test/")) {
        return await originalFetch(request)
      }

      expect(request.headers.get("authorization")).toContain("AWS4-HMAC-SHA256")
      expect(Boolean(request.headers.get("x-amz-date"))).toBe(true)

      if (request.method === "PUT") {
        const body = new Uint8Array(await request.arrayBuffer())
        storedObjects.set(request.url, {
          body,
          contentType: request.headers.get("content-type") || "application/octet-stream",
        })
        return new Response(null, {
          status: 200,
          headers: { "x-amz-meta-cid": "bafycommunityavatarcid" },
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

    const session = await exchangeJwt(ctx.env, "community-media-user")
    const fileBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4])
    const formData = new FormData()
    formData.set("kind", "avatar")
    formData.set("file", new File([fileBytes], "avatar.png", { type: "image/png" }))

    const uploadResponse = await app.request(
      "http://pirate.test/community-media",
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
    expect(uploadBody.kind).toBe("avatar")
    expect(uploadBody.media_ref).toBe("https://psc.myfilebase.com/ipfs/bafycommunityavatarcid")
    expect((uploadBody as { ipfs_cid?: string }).ipfs_cid).toBe("bafycommunityavatarcid")
    expect(uploadBody.mime_type).toBe("image/png")
    expect(uploadBody.size_bytes).toBe(fileBytes.byteLength)
    expect(uploadBody.storage_bucket).toBe("pirate-media")
    expect(uploadBody.storage_object_key).toMatch(/^community-media\/avatar\/avatar_[a-z0-9]+\.png$/)

    const objectName = uploadBody.storage_object_key.split("/").pop() ?? ""
    const readResponse = await app.request(`http://pirate.test/community-media/avatar/${objectName}`, {}, ctx.env)
    expect(readResponse.status).toBe(200)
    expect(readResponse.headers.get("content-type")).toBe("image/png")
    expect(readResponse.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    const readBytes = new Uint8Array(await readResponse.arrayBuffer())
    expect([...readBytes]).toEqual([...fileBytes])
  })

  test("rejects unsupported media types before any bucket write", async () => {
    let filebaseCalled = false
    ;(globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }).fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.url.startsWith("https://s3.filebase.test/")) {
        filebaseCalled = true
        return new Response(null, {
          status: 200,
          headers: { "x-amz-meta-cid": "bafycommunitypostimagecid" },
        })
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

    const session = await exchangeJwt(ctx.env, "community-media-invalid")
    const formData = new FormData()
    formData.set("kind", "banner")
    formData.set("file", new File(["plain text"], "banner.txt", { type: "text/plain" }))

    const response = await app.request(
      "http://pirate.test/community-media",
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
    expect(body.message).toBe("banner must be a JPEG, PNG, WebP, GIF, or AVIF image")
    expect(filebaseCalled).toBe(false)
  })

  test("uploads post image media to Filebase", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    ;(globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }).fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
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
          headers: { "x-amz-meta-cid": "bafycommunitypostimagecid" },
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

    const session = await exchangeJwt(ctx.env, "community-media-post-image")
    const fileBytes = new Uint8Array([71, 73, 70, 56, 57, 97, 1, 2, 3, 4])
    const formData = new FormData()
    formData.set("kind", "post_image")
    formData.set("file", new File([fileBytes], "post.gif", { type: "image/gif" }))

    const uploadResponse = await app.request(
      "http://pirate.test/community-media",
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
      storage_object_key: string
    }
    expect(uploadBody.kind).toBe("post_image")
    expect(uploadBody.media_ref).toBe("https://psc.myfilebase.com/ipfs/bafycommunitypostimagecid")
    expect((uploadBody as { ipfs_cid?: string }).ipfs_cid).toBe("bafycommunitypostimagecid")
    expect(uploadBody.mime_type).toBe("image/gif")
    expect(uploadBody.size_bytes).toBe(fileBytes.byteLength)
    expect(uploadBody.storage_object_key).toMatch(/^community-media\/post_image\/post_image_[a-z0-9]+\.gif$/)

    const objectName = uploadBody.storage_object_key.split("/").pop() ?? ""
    const readResponse = await app.request(`http://pirate.test/community-media/post_image/${objectName}`, {}, ctx.env)
    expect(readResponse.status).toBe(200)
    expect(readResponse.headers.get("content-type")).toBe("image/gif")
    const readBytes = new Uint8Array(await readResponse.arrayBuffer())
    expect([...readBytes]).toEqual([...fileBytes])
  })

  test("uploads AVIF post image media to Filebase", async () => {
    const storedObjects = new Map<string, { body: Uint8Array; contentType: string }>()
    ;(globalThis as { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }).fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
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
          headers: { "x-amz-meta-cid": "bafycommunityavifcid" },
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

    const session = await exchangeJwt(ctx.env, "community-media-post-avif")
    const formData = new FormData()
    formData.set("kind", "post_image")
    formData.set("file", new File([new Uint8Array([65, 86, 73, 70, 1, 2, 3, 4])], "post.avif", { type: "image/avif" }))

    const uploadResponse = await app.request(
      "http://pirate.test/community-media",
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
      storage_object_key: string
    }
    expect(uploadBody.kind).toBe("post_image")
    expect(uploadBody.media_ref).toBe("https://psc.myfilebase.com/ipfs/bafycommunityavifcid")
    expect((uploadBody as { ipfs_cid?: string }).ipfs_cid).toBe("bafycommunityavifcid")
    expect(uploadBody.mime_type).toBe("image/avif")
    expect(uploadBody.storage_object_key).toMatch(/^community-media\/post_image\/post_image_[a-z0-9]+\.avif$/)
  })

})
