import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"

import { readWranglerVars } from "../scripts/_lib/dev-vars"

const wranglerConfigPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url))

describe("verification endpoint environment config", () => {
  test("configures community credential encryption version for development, staging, and production", () => {
    for (const environment of ["development", "staging", "production"]) {
      const vars = readWranglerVars(wranglerConfigPath, environment)

      expect(vars.CREDENTIAL_WRAP_KEY_VERSION).toBe("2")
    }
  })

  test("pins staging API verification callbacks and browser CORS to staging origins", () => {
    const vars = readWranglerVars(wranglerConfigPath, "staging")

    expect(vars.ENVIRONMENT).toBe("staging")
    expect(vars.PIRATE_API_PUBLIC_ORIGIN).toBe("https://api-staging.pirate.sc")
    expect(vars.PIRATE_WEB_PUBLIC_ORIGIN).toBe("https://staging.pirate.sc")
    expect(vars.CORS_ALLOWED_ORIGINS).toBe("https://staging.pirate.sc")
    expect(vars.VERY_APP_ID).toBe("4d87383a-1f3e-486d-8df4-38a8ead86d10")
  })

  test("pins production API verification callbacks and browser CORS to production origins", () => {
    const vars = readWranglerVars(wranglerConfigPath, "production")

    expect(vars.ENVIRONMENT).toBe("production")
    expect(vars.PIRATE_API_PUBLIC_ORIGIN).toBe("https://api.pirate.sc")
    expect(vars.PIRATE_WEB_PUBLIC_ORIGIN).toBe("https://pirate.sc")
    expect(vars.CORS_ALLOWED_ORIGINS).toBe("https://pirate.sc,https://www.pirate.sc")
    expect(vars.VERY_APP_ID).toBe("4d87383a-1f3e-486d-8df4-38a8ead86d10")
  })
})
