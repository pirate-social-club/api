import { afterEach, describe, expect, test } from "bun:test"

import { resolveHostBookable, setHostBookableConfigLoaderForTests, type HostBookableConfig } from "./host-bookable"

const env = {} as never

function withConfig(config: HostBookableConfig | null, throwErr = false): void {
  setHostBookableConfigLoaderForTests(async () => {
    if (throwErr) throw new Error("boom")
    return config
  })
}

describe("resolveHostBookable (read-on-serve is_bookable)", () => {
  afterEach(() => setHostBookableConfigLoaderForTests(null))

  test("published + at least one availability rule → true", async () => {
    withConfig({ profile: { isPublished: true }, availabilityRules: [{}] })
    expect(await resolveHostBookable(env, "usr_1")).toBe(true)
  })

  test("published but no availability rules → false", async () => {
    withConfig({ profile: { isPublished: true }, availabilityRules: [] })
    expect(await resolveHostBookable(env, "usr_1")).toBe(false)
  })

  test("not published → false (even with availability)", async () => {
    withConfig({ profile: { isPublished: false }, availabilityRules: [{}] })
    expect(await resolveHostBookable(env, "usr_1")).toBe(false)
  })

  test("no booking profile (null config) → false", async () => {
    withConfig(null)
    expect(await resolveHostBookable(env, "usr_1")).toBe(false)
  })

  test("read error / absent schema → false (fail-safe)", async () => {
    withConfig(null, true)
    expect(await resolveHostBookable(env, "usr_1")).toBe(false)
  })
})
