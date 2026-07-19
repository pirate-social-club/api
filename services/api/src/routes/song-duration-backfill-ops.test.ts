import { expect, test } from "bun:test"

import type { Env } from "../env"
import { app } from "../index"

test("song duration backfill rejects requests without an operator credential", async () => {
  const response = await app.request("/operator/song-duration-backfill/batches", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ community_id: "com_test" }),
  }, {} as Env)

  expect(response.status).toBe(401)
  expect(await response.json()).toMatchObject({ code: "auth_error" })
})
