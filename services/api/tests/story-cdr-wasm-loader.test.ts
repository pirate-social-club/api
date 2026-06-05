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

  test("initializes the TDH2 WASM module from a precompiled WebAssembly.Module", async () => {
    const wasmBinary = await readFile(
      new URL("../src/vendor/piplabs/cdr-crypto/wasm/cb-mpc-tdh2.wasm", import.meta.url),
    )
    const wasmModule = await WebAssembly.compile(Uint8Array.from(wasmBinary))

    await initWasm({ wasmModule })

    expect(getWasm()).not.toBeNull()
  })

  test("keeps the Emscripten wrapper on Worker-safe WASM loading paths", async () => {
    const wrapperSource = await readFile(new URL("../src/vendor/piplabs/cdr-crypto/wasm/cb-mpc-tdh2.js", import.meta.url), "utf8")
    const loaderSource = await readFile(new URL("../src/vendor/piplabs/cdr-crypto/wasm/loader.js", import.meta.url), "utf8")
    const wranglerConfig = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")

    expect(wrapperSource).toContain('globalThis.navigator?.userAgent==="Cloudflare-Workers"')
    expect(wrapperSource).toContain("var ENVIRONMENT_IS_NODE=!ENVIRONMENT_IS_WORKER&&globalThis.process?.versions?.node")
    expect(wrapperSource).toContain('Module["wasmModule"]')
    expect(loaderSource).toContain("locateFile: (path) => path")
    expect(loaderSource).toContain("configure the worker bundler to import cb-mpc-tdh2.wasm as CompiledWasm")
    expect(wranglerConfig).toContain('"type": "CompiledWasm"')
  })
})
