import { describe, expect, test } from "bun:test"

import {
  isTryCloudflareOrigin,
  mergeCommaSeparatedValues,
  parseTryCloudflareUrl,
} from "../scripts/_lib/dev-public-tunnel"

describe("dev public tunnel helpers", () => {
  test("extracts a trycloudflare URL from cloudflared output", () => {
    expect(parseTryCloudflareUrl([
      "2026-04-28T00:00:00Z INF Requesting new quick Tunnel",
      "2026-04-28T00:00:01Z INF +--------------------------------------------------------------------------------------------+",
      "2026-04-28T00:00:01Z INF |  https://fresh-maritime-complete-lesser.trycloudflare.com                 |",
    ].join("\n"))).toBe("https://fresh-maritime-complete-lesser.trycloudflare.com")
  })

  test("does not treat Cloudflare's API origin as a published tunnel", () => {
    expect(parseTryCloudflareUrl([
      "2026-04-28T00:00:00Z INF Requesting new quick Tunnel on trycloudflare.com",
      "failed to request quick Tunnel: Post \"https://api.trycloudflare.com/tunnel\": tls failed",
    ].join("\n"))).toBeNull()
  })

  test("detects quick tunnel origins", () => {
    expect(isTryCloudflareOrigin("https://fresh-maritime-complete-lesser.trycloudflare.com")).toBe(true)
    expect(isTryCloudflareOrigin("https://api.trycloudflare.com/tunnel")).toBe(false)
    expect(isTryCloudflareOrigin("http://fresh-maritime-complete-lesser.trycloudflare.com")).toBe(false)
    expect(isTryCloudflareOrigin("https://api.pirate.sc")).toBe(false)
  })

  test("merges comma-separated env values without duplicating origins", () => {
    expect(mergeCommaSeparatedValues(
      "http://localhost:5173, https://staging.pirate.sc",
      ["http://localhost:5173", "http://127.0.0.1:5173"],
    )).toBe("http://localhost:5173,https://staging.pirate.sc,http://127.0.0.1:5173")
  })
})
