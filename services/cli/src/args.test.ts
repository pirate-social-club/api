import { describe, expect, test } from "bun:test"
import { getFlag, hasFlag, parseArgs, requireFlag } from "./args.js"

describe("parseArgs", () => {
  test("parses positionals and string flags", () => {
    const result = parseArgs(["auth", "login", "--jwt", "token", "--base-url", "http://localhost:8787"])
    expect(result.positionals).toEqual(["auth", "login"])
    expect(getFlag(result, "jwt")).toBe("token")
    expect(getFlag(result, "base-url")).toBe("http://localhost:8787")
  })

  test("parses boolean flags", () => {
    const result = parseArgs(["verify", "namespace", "complete", "nvs_123", "--restart-challenge"])
    expect(result.positionals).toEqual(["verify", "namespace", "complete", "nvs_123"])
    expect(hasFlag(result, "restart-challenge")).toBe(true)
  })

  test("requireFlag throws when missing", () => {
    const args = parseArgs(["community", "create"])
    expect(() => requireFlag(args, "display-name")).toThrow("Missing required flag --display-name")
  })
})
