/**
 * JSON-RPC transport for the rehearsal preflight.
 *
 * The reader OWNS its endpoint. A caller cannot validate one URL and hand over
 * a reader connected somewhere else, and cannot widen the allow-list: the
 * permitted hosts are source-controlled here, and the URL is validated before
 * the object exists or any socket is opened.
 *
 * Reads are pinned by block HASH (EIP-1898), not height. A block number alone
 * is not a snapshot: under a reorg the block at a given height can change
 * between reads.
 *
 * Degradation is deliberately narrow. Only a recognized "this capability does
 * not exist" response may downgrade a hash tag to a height tag, or the
 * `finalized` tag to a fixed depth. A timeout, HTTP failure, rate limit,
 * malformed response, contract revert or any other RPC error fails closed —
 * otherwise a flaky endpoint silently buys itself weaker guarantees.
 *
 * No thrown message ever contains the URL, its query string, response bodies or
 * headers. RPC endpoints routinely carry API keys in the path or query, and an
 * error string is the easiest way to leak one into a log or an evidence file.
 */

/** Source-controlled. Not caller-supplied, by design. */
export const ALLOWED_RPC_HOSTS = ["sepolia.base.org"] as const

export const CONFIRMATION_TAG = "finalized"
export const CONFIRMATION_DEPTH_FALLBACK = 8

const REQUEST_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 256 * 1024

/**
 * JSON-RPC codes that mean "this endpoint does not implement what you asked
 * for". Only these may trigger a capability downgrade.
 *
 * Deliberately excludes -32000 and 3, which providers use for execution
 * reverts, and every transport/HTTP failure.
 */
const CAPABILITY_ERROR_CODES = new Set([-32601, -32602])

export type RpcFailureKind = "transport" | "http" | "protocol" | "rpc" | "capability"

export class RehearsalRpcError extends Error {
  readonly kind: RpcFailureKind
  readonly rpcErrorCode: number | null

  constructor(message: string, kind: RpcFailureKind, rpcErrorCode: number | null = null) {
    super(message)
    this.kind = kind
    this.rpcErrorCode = rpcErrorCode
  }
}

function fail(message: string, kind: RpcFailureKind, code: number | null = null): never {
  throw new RehearsalRpcError(`rehearsal rpc: ${message}`, kind, code)
}

/** Only a capability error may relax a guarantee. */
function isCapabilityFailure(error: unknown): boolean {
  return error instanceof RehearsalRpcError && error.kind === "capability"
}

const HEX_DATA_RE = /^0x(?:[0-9a-fA-F]{2})*$/u
const HEX_QUANTITY_RE = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u
const BLOCK_HASH_RE = /^0x[0-9a-fA-F]{64}$/u

export type BlockRef = { number: number; hash: string }

export type ConfirmationPolicy = {
  kind: "finalized-tag" | "fixed-depth"
  depth: number | null
}

export function assertAllowedRpcUrl(rpcUrl: string): { host: string } {
  let parsed: URL
  try {
    parsed = new URL(rpcUrl)
  } catch {
    fail("endpoint is not a valid URL", "protocol")
  }
  if (parsed.protocol !== "https:") fail("endpoint must be HTTPS", "protocol")
  if (!(ALLOWED_RPC_HOSTS as readonly string[]).includes(parsed.host)) {
    // Host only. Never the full URL — it may carry a key.
    fail(`endpoint host ${parsed.host} is not on the source-controlled allow-list`, "protocol")
  }
  return { host: parsed.host }
}

type FetchLike = typeof fetch

export class RehearsalRpcReader {
  readonly host: string
  #url: string
  #fetch: FetchLike
  #nextId = 1
  #snapshot: BlockRef | null = null
  #hashTagSupported = true
  #completedReads = 0
  #downgradedReads = 0
  #confirmationPolicy: ConfirmationPolicy = { kind: "finalized-tag", depth: null }

  private constructor(url: string, host: string, fetchImpl: FetchLike) {
    this.#url = url
    this.host = host
    this.#fetch = fetchImpl
  }

  static create(options: { rpcUrl: string; fetchImpl?: FetchLike }): RehearsalRpcReader {
    const { host } = assertAllowedRpcUrl(options.rpcUrl)
    return new RehearsalRpcReader(options.rpcUrl, host, options.fetchImpl ?? fetch)
  }

  get confirmationPolicy(): ConfirmationPolicy {
    return this.#confirmationPolicy
  }

  /**
   * True only when reads actually happened AND none of them degraded. An
   * initial capability assumption is not evidence.
   */
  get readsWereHashPinned(): boolean {
    return this.#completedReads > 0 && this.#downgradedReads === 0
  }

  /** Streams the body with a hard BYTE ceiling; never allocates it whole first. */
  async #readBodyLimited(response: Response, method: string): Promise<string> {
    const declared = response.headers.get("content-length")
    if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
      fail(`${method} response exceeds the size ceiling`, "protocol")
    }
    const body = response.body
    if (body === null) fail(`${method} response had no body`, "protocol")

    const reader = body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value === undefined) continue
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        fail(`${method} response exceeds the size ceiling`, "protocol")
      }
      chunks.push(value)
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder("utf-8").decode(merged)
  }

  async #rpc(method: string, params: unknown[], options: { allowNullResult?: boolean } = {}) {
    const id = this.#nextId++
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let response: Response
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        redirect: "error",
        signal: controller.signal,
      })
    } catch {
      // Opaque on purpose: the underlying error can embed the URL.
      fail(`${method} request failed, timed out, or was redirected`, "transport")
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) fail(`${method} returned HTTP ${response.status}`, "http")

    const text = await this.#readBodyLimited(response, method)

    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      fail(`${method} response was not valid JSON`, "protocol")
    }
    if (Array.isArray(body)) fail(`${method} returned a batch response`, "protocol")
    if (typeof body !== "object" || body === null) fail(`${method} response was not an object`, "protocol")

    const envelope = body as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown }
    if (envelope.jsonrpc !== "2.0") fail(`${method} response had a bad jsonrpc version`, "protocol")
    if (envelope.id !== id) fail(`${method} response id did not match the request`, "protocol")
    if (envelope.error !== undefined) {
      const rawCode = (envelope.error as { code?: unknown } | null)?.code
      const code = typeof rawCode === "number" ? rawCode : null
      // Code only. Provider error messages routinely echo the request URL.
      fail(
        `${method} returned a JSON-RPC error (code ${String(code ?? "unknown")})`,
        code !== null && CAPABILITY_ERROR_CODES.has(code) ? "capability" : "rpc",
        code,
      )
    }
    if (!("result" in envelope) || envelope.result === undefined) {
      fail(`${method} returned no result`, "protocol")
    }
    if (envelope.result === null) {
      if (options.allowNullResult === true) return null
      fail(`${method} returned a null result`, "protocol")
    }
    return envelope.result
  }

  #hexData(value: unknown, method: string): string {
    if (typeof value !== "string" || !HEX_DATA_RE.test(value)) {
      fail(`${method} returned malformed hex data`, "protocol")
    }
    return value
  }

  #hexQuantity(value: unknown, method: string): bigint {
    if (typeof value !== "string" || !HEX_QUANTITY_RE.test(value)) {
      fail(`${method} returned a malformed hex quantity`, "protocol")
    }
    return BigInt(value)
  }

  #decodeBlock(raw: unknown, method: string): BlockRef {
    const block = raw as { number?: unknown; hash?: unknown }
    const number = this.#hexQuantity(block.number, method)
    if (typeof block.hash !== "string" || !BLOCK_HASH_RE.test(block.hash)) {
      fail(`${method} returned a malformed block hash`, "protocol")
    }
    return { number: Number(number), hash: block.hash.toLowerCase() }
  }

  /** Chain identity is proven before any other RPC work. */
  async chainId(): Promise<number> {
    const value = this.#hexQuantity(await this.#rpc("eth_chainId", []), "eth_chainId")
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail("eth_chainId is implausibly large", "protocol")
    return Number(value)
  }

  async latestConfirmedBlock(): Promise<BlockRef> {
    let raw: unknown
    try {
      raw = await this.#rpc("eth_getBlockByNumber", [CONFIRMATION_TAG, false], {
        allowNullResult: true,
      })
    } catch (error) {
      // ONLY a capability error means the tag is unsupported. A timeout, 429 or
      // malformed response must not silently weaken the confirmation policy.
      if (!isCapabilityFailure(error)) throw error
      raw = null
    }
    if (raw === null) {
      this.#confirmationPolicy = { kind: "fixed-depth", depth: CONFIRMATION_DEPTH_FALLBACK }
      const head = this.#hexQuantity(await this.#rpc("eth_blockNumber", []), "eth_blockNumber")
      const target = head - BigInt(CONFIRMATION_DEPTH_FALLBACK)
      if (target < 0n) fail("chain head is shallower than the confirmation depth", "protocol")
      raw = await this.#rpc("eth_getBlockByNumber", [`0x${target.toString(16)}`, false])
    }
    const ref = this.#decodeBlock(raw, "eth_getBlockByNumber")
    this.#snapshot = ref
    return ref
  }

  #blockTag(block: BlockRef): unknown {
    return this.#hashTagSupported
      ? { blockHash: block.hash, requireCanonical: true }
      : `0x${block.number.toString(16)}`
  }

  async #withBlockTag<T>(block: BlockRef, run: (tag: unknown) => Promise<T>): Promise<T> {
    try {
      const value = await run(this.#blockTag(block))
      this.#completedReads += 1
      if (!this.#hashTagSupported) this.#downgradedReads += 1
      return value
    } catch (error) {
      // Downgrade ONLY on a recognized capability error, and only once.
      if (!this.#hashTagSupported || !isCapabilityFailure(error)) throw error
      this.#hashTagSupported = false
      const value = await run(this.#blockTag(block))
      this.#completedReads += 1
      this.#downgradedReads += 1
      return value
    }
  }

  async getCode(address: string, block: BlockRef): Promise<string> {
    return await this.#withBlockTag(block, async (tag) =>
      this.#hexData(await this.#rpc("eth_getCode", [address, tag]), "eth_getCode"),
    )
  }

  async call(to: string, data: string, block: BlockRef): Promise<string> {
    return await this.#withBlockTag(block, async (tag) =>
      this.#hexData(await this.#rpc("eth_call", [{ to, data }, tag]), "eth_call"),
    )
  }

  async getBalance(address: string, block: BlockRef): Promise<bigint> {
    return await this.#withBlockTag(block, async (tag) =>
      this.#hexQuantity(await this.#rpc("eth_getBalance", [address, tag]), "eth_getBalance"),
    )
  }

  /**
   * Re-verifies the snapshot after all reads.
   *
   * Fetches THE ORIGINAL captured block number and requires the same hash.
   * Re-deriving the confirmed block instead would select a later block as the
   * head advances and report a false reorg on every degraded run.
   *
   * A no-op when every read was hash-pinned, since EIP-1898 with
   * requireCanonical already guarantees it.
   */
  async assertSnapshotIntact(): Promise<void> {
    const captured = this.#snapshot
    if (captured === null) fail("no snapshot was captured", "protocol")
    if (this.#downgradedReads === 0) return
    const raw = await this.#rpc("eth_getBlockByNumber", [
      `0x${captured.number.toString(16)}`,
      false,
    ])
    const observed = this.#decodeBlock(raw, "eth_getBlockByNumber")
    if (observed.hash !== captured.hash) {
      fail(
        `snapshot was reorganised during the preflight (block ${captured.number}`
          + ` ${captured.hash} is now ${observed.hash}); discard this evidence`,
        "protocol",
      )
    }
  }
}
