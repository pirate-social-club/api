import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const ipfsOnlyHash = require(fileURLToPath(
  new URL("../../../../../scripts/lit/node_modules/ipfs-only-hash/index.js", import.meta.url),
)) as {
  of(content: Uint8Array | string, options?: Record<string, unknown>): Promise<string>
}

export async function computeIpfsUnixFsCid(bytes: Uint8Array): Promise<string> {
  return await ipfsOnlyHash.of(bytes)
}

export async function assertIpfsUnixFsCid(input: {
  bytes: Uint8Array
  expectedCid: string
  label: string
}): Promise<void> {
  const expectedCid = String(input.expectedCid || "").trim().replace(/^ipfs:\/\//, "")
  if (!expectedCid) {
    throw new Error(`${input.label}_expected_cid_missing`)
  }
  const actualCid = await computeIpfsUnixFsCid(input.bytes)
  if (actualCid !== expectedCid) {
    throw new Error(`${input.label}_cid_mismatch:${expectedCid}:${actualCid}`)
  }
}
