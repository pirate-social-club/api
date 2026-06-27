import { describe, expect, test } from "bun:test"
import { app } from "../../src/index"
import { KARAOKE_RUNTIME_BUILD } from "@pirate-social-club/karaoke-runtime/build"
import type { Env } from "../../src/env"

describe("GET /__version", () => {
  test("surfaces the bundled @pirate-social-club/karaoke-runtime version + gitSha", async () => {
    const response = await app.request(
      "http://pirate.test/__version",
      {},
      {} as Env,
    )
    expect(response.status).toBe(200)

    const body = (await response.json()) as {
      karaoke_runtime?: { version: string; git_sha: string }
    }
    expect(body.karaoke_runtime).toEqual({
      version: KARAOKE_RUNTIME_BUILD.version,
      git_sha: KARAOKE_RUNTIME_BUILD.gitSha,
    })
    // Pinned to the published registry version this worker bundles.
    expect(body.karaoke_runtime?.version).toBe("0.1.0")
  })
})
