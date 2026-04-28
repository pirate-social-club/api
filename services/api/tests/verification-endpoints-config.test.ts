import { describe, expect, test } from "bun:test"

import { readWranglerVars } from "../scripts/_lib/dev-vars"

describe("verification endpoint environment config", () => {
  test("pins staging API verification callbacks and browser CORS to staging origins", () => {
    const vars = readWranglerVars("wrangler.jsonc", "staging")

    expect(vars.ENVIRONMENT).toBe("staging")
    expect(vars.PIRATE_API_PUBLIC_ORIGIN).toBe("https://api-staging.pirate.sc")
    expect(vars.CORS_ALLOWED_ORIGINS).toBe("https://staging.pirate.sc")
  })

  test("pins production API verification callbacks and browser CORS to production origins", () => {
    const vars = readWranglerVars("wrangler.jsonc", "production")

    expect(vars.ENVIRONMENT).toBe("production")
    expect(vars.PIRATE_API_PUBLIC_ORIGIN).toBe("https://api.pirate.sc")
    expect(vars.CORS_ALLOWED_ORIGINS).toBe("https://pirate.sc,https://www.pirate.sc")
  })
})
