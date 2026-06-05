import { afterEach, describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { getWasm, initWasm, resetWasm } from "../src/vendor/piplabs/cdr-crypto/wasm/loader.js"

afterEach(() => {
  resetWasm()
})

describe("Story CDR WASM loader", () => {
  test("initializes the bundled TDH2 WASM module from imported bytes", async () => {
    await initWasm()

    expect(getWasm()).not.toBeNull()
  })

  test("keeps the Emscripten wrapper off the Node filesystem path in Cloudflare Workers", async () => {
    const wrapperSource = await readFile(new URL("../src/vendor/piplabs/cdr-crypto/wasm/cb-mpc-tdh2.js", import.meta.url), "utf8")
    const loaderSource = await readFile(new URL("../src/vendor/piplabs/cdr-crypto/wasm/loader.js", import.meta.url), "utf8")

    expect(wrapperSource).toContain('globalThis.navigator?.userAgent==="Cloudflare-Workers"')
    expect(wrapperSource).toContain("var ENVIRONMENT_IS_NODE=!ENVIRONMENT_IS_WORKER&&globalThis.process?.versions?.node")
    expect(loaderSource).toContain("locateFile: (path) => path")
  })
})
