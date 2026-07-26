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
 * between reads. Where the endpoint does not support hash tags, the reader
 * degrades to height tags and the caller must re-verify the head afterwards via
 * {@link RehearsalRpcReader.assertSnapshotIntact}.
 *
 * No thrown message ever contains the URL, its query string, response bodies or
 * headers. RPC endpoints routinely carry API keys in the path or query, and an
 * error string is the easiest way to leak one into a log or an evidence file.
 */

/** Source-controlled. Not caller-supplied, by design. */
export const ALLOWED_RPC_HOSTS = ["sepolia.base.org"] as const

/**
 * "Confirmed" for this rehearsal. Base Sepolia exposes `finalized`; where it is
 * unavailable the reader falls back to a fixed depth below head. The policy in
 * force is recorded in evidence so a reviewer can see which applied.
 */
export const CONFIRMATION_TAG = "finalized"
export const CONFIRMATION_DEPTH_FALLBACK = 8

const REQUEST_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 256 * 1024

export class RehearsalRpcError extends Error {}

function fail(message: string): never {
  throw new RehearsalRpcError(`rehearsal rpc: ${message}`)
}

const HEX_DATA_RE = /^0x(?:[0-9a-fA-F]{2})*$/u
const HEX_QUANTITY_RE = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/u
const BLOCK_HASH_RE = /^0x[0-9a-fA-F]{64}$/u

export type BlockRef = { number: number; hash: string }

export type ConfirmationPolicy = {
  kind: "finalized-tag" | "fixed-depth"
  depth: number | null
}

/**
 * Validates an endpoint against the source-controlled allow-list.
 * Exported for tests; the reader calls it itself and callers cannot bypass it.
 */
export function assertAllowedRpcUrl(rpcUrl: string): { host: string } {
  let parsed: URL
  try {
    parsed = new URL(rpcUrl)
  } catch {
    fail("endpoint is not a valid URL")
  }
  if (parsed.protocol !== "https:") fail("endpoint must be HTTPS")
  if (!(ALLOWED_RPC_HOSTS as readonly string[]).includes(parsed.host)) {
    // Host only. Never the full URL — it may carry a key.
    fail(`endpoint host ${parsed.host} is not on the source-controlled allow-list`)
  }
  return { host: parsed.host }
}

type FetchLike = typeof fetch

export class RehearsalRpcReader {
  readonly host: string
  readonly confirmationPolicy: ConfirmationPolicy
  #url: string
  #fetch: FetchLike
  #nextId = 1
  #snapshot: BlockRef | null = null
  #supportsBlockHashTag = true

  private constructor(url: string, host: string, fetchImpl: FetchLike, policy: ConfirmationPolicy) {
    this.#url = url
    this.host = host
    this.#fetch = fetchImpl
    this.confirmationPolicy = policy
  }

  /** The only constructor. Validates before anything exists or connects. */
  static create(options: { rpcUrl: string; fetchImpl?: FetchLike }): RehearsalRpcReader {
    const { host } = assertAllowedRpcUrl(options.rpcUrl)
    return new RehearsalRpcReader(options.rpcUrl, host, options.fetchImpl ?? fetch, {
      kind: "finalized-tag",
      depth: null,
    })
  }

  async #rpc(method: string, params: unknown[]): Promise<unknown> {
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
      // Deliberately opaque: the underlying error can embed the URL.
      fail(`${method} request failed or was redirected`)
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) fail(`${method} returned HTTP ${response.status}`)

    const declared = response.headers.get("content-length")
    if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
      fail(`${method} response exceeds the size ceiling`)
    }
    const text = await response.text()
    if (text.length > MAX_RESPONSE_BYTES) fail(`${method} response exceeds the size ceiling`)

    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      fail(`${method} response was not valid JSON`)
    }
    if (Array.isArray(body)) fail(`${method} returned a batch response`)
    if (typeof body !== "object" || body === null) fail(`${method} response was not an object`)

    const envelope = body as { jsonrpc?: unknown; id?: unknown; result?: unknown; error?: unknown }
    if (envelope.jsonrpc !== "2.0") fail(`${method} response had a bad jsonrpc version`)
    if (envelope.id !== id) fail(`${method} response id did not match the request`)
    if (envelope.error !== undefined) {
      const code = (envelope.error as { code?: unknown } | null)?.code
      // Code only. Provider error messages routinely echo the request URL.
      fail(`${method} returned a JSON-RPC error (code ${String(code ?? "unknown")})`)
    }
    if (!("result" in envelope) || envelope.result === undefined || envelope.result === null) {
      fail(`${method} returned no result`)
    }
    return envelope.result
  }

  #hexData(value: unknown, method: string): string {
    if (typeof value !== "string" || !HEX_DATA_RE.test(value)) {
      fail(`${method} returned malformed hex data`)
    }
    return value
  }

  #hexQuantity(value: unknown, method: string): bigint {
    if (typeof value !== "string" || !HEX_QUANTITY_RE.test(value)) {
      fail(`${method} returned a malformed hex quantity`)
    }
    return BigInt(value)
  }

  /** Chain identity is proven before any other RPC work. */
  async chainId(): Promise<number> {
    const value = this.#hexQuantity(await this.#rpc("eth_chainId", []), "eth_chainId")
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail("eth_chainId is implausibly large")
    return Number(value)
  }

  async latestConfirmedBlock(): Promise<BlockRef> {
    let raw: unknown
    try {
      raw = await this.#rpc("eth_getBlockByNumber", [CONFIRMATION_TAG, false])
    } catch {
      // Endpoint does not support the finalized tag; fall back to a fixed depth.
      const head = this.#hexQuantity(await this.#rpc("eth_blockNumber", []), "eth_blockNumber")
      const target = head - BigInt(CONFIRMATION_DEPTH_FALLBACK)
      if (target < 0n) fail("chain head is shallower than the confirmation depth")
      ;(this.confirmationPolicy as ConfirmationPolicy) = {
        kind: "fixed-depth",
        depth: CONFIRMATION_DEPTH_FALLBACK,
      }
      raw = await this.#rpc("eth_getBlockByNumber", [`0x${target.toString(16)}`, false])
    }
    const block = raw as { number?: unknown; hash?: unknown }
    const number = this.#hexQuantity(block.number, "eth_getBlockByNumber")
    if (typeof block.hash !== "string" || !BLOCK_HASH_RE.test(block.hash)) {
      fail("eth_getBlockByNumber returned a malformed block hash")
    }
    const ref = { number: Number(number), hash: block.hash.toLowerCase() }
    this.#snapshot = ref
    return ref
  }

  /** EIP-1898 hash tag where supported, height otherwise. */
  #blockTag(block: BlockRef): unknown {
    return this.#supportsBlockHashTag
      ? { blockHash: block.hash, requireCanonical: true }
      : `0x${block.number.toString(16)}`
  }

  async #withBlockTag<T>(block: BlockRef, run: (tag: unknown) => Promise<T>): Promise<T> {
    try {
      return await run(this.#blockTag(block))
    } catch (error) {
      if (!this.#supportsBlockHashTag) throw error
      // One downgrade, then the caller must re-verify the head afterwards.
      this.#supportsBlockHashTag = false
      return await run(this.#blockTag(block))
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

  /** True when every read was pinned by block hash and no reorg is possible. */
  get readsWereHashPinned(): boolean {
    return this.#supportsBlockHashTag
  }

  /**
   * Re-verifies the snapshot after all reads.
   *
   * Only meaningful when the endpoint lacked hash tags and reads were pinned by
   * height. Re-fetches the confirmed block and requires the same hash; a
   * different hash means the height was reorganised mid-preflight, so the
   * evidence describes a state that never coherently existed and is discarded.
   */
  async assertSnapshotIntact(): Promise<void> {
    if (this.#snapshot === null) fail("no snapshot was captured")
    if (this.#supportsBlockHashTag) return
    const before = this.#snapshot
    const after = await this.latestConfirmedBlock()
    if (after.hash !== before.hash || after.number !== before.number) {
      fail(
        `snapshot was reorganised during the preflight`
          + ` (block ${before.number} ${before.hash} became ${after.number} ${after.hash});`
          + " discard this evidence",
      )
    }
  }
}
