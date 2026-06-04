import { afterEach, describe, expect, test } from "bun:test"
import { getWasm, initWasm, resetWasm } from "../src/vendor/piplabs/cdr-crypto/wasm/loader.js"

afterEach(() => {
  resetWasm()
})

describe("Story CDR WASM loader", () => {
  test("initializes the bundled TDH2 WASM module from imported bytes", async () => {
    await initWasm()

    expect(getWasm()).not.toBeNull()
  })
})
