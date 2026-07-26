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

/**
 * Required historical retention, derived rather than guessed.
 *
 * The drill plus its evidence gathering and reconciliation cleanup must all be
 * re-readable afterwards: a trace or block lookup that has been pruned cannot
 * be re-verified by a reviewer. Base produces a block roughly every 2s.
 */
import { REWARD_VAULT_TRACE_OPTIONS } from "../../src/lib/rewards/reward-vault-revert-evidence"

export const BASE_BLOCK_TIME_SECONDS = 2
export const REHEARSAL_REQUIRED_RETENTION_HOURS = 72
export const REHEARSAL_REQUIRED_RETENTION_BLOCKS =
  (REHEARSAL_REQUIRED_RETENTION_HOURS * 3600) / BASE_BLOCK_TIME_SECONDS

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

/** Archived selection-time evidence that an endpoint can support the drill. */
export type ProviderQualification = {
  host: string
  chainId: number
  confirmationPolicy: ConfirmationPolicy
  probedBlockNumber: number
  probedBlockHash: string
  supportsBlockHashTags: boolean
  supportsDebugTrace: boolean
  /** The real confirmed transaction actually traced, proving usable entitlement. */
  tracedTransactionHash: string | null
  historicalBlockReadable: boolean
  /** Source-controlled depth the endpoint had to satisfy. */
  rehearsalRequiredRetentionBlocks: number
  /** The actual historical height probed, not merely the confirmed head. */
  testedHistoricalBlock: number
  capturedAt: string
  qualified: boolean
  failures: string[]
}

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

  /**
   * Finds a confirmed transaction to trace, walking back from the confirmed
   * block until a non-empty one is found. Preferred over a hard-coded hash,
   * which would fall outside the retention horizon and start failing.
   */
  async #findProbeTransaction(fromBlock: number, maxLookback = 25): Promise<string> {
    for (let height = fromBlock; height > fromBlock - maxLookback && height >= 0; height -= 1) {
      const raw = await this.#rpc(
        "eth_getBlockByNumber",
        [`0x${height.toString(16)}`, true],
        { allowNullResult: true },
      )
      if (raw === null) continue
      const transactions = (raw as { transactions?: unknown }).transactions
      if (!Array.isArray(transactions) || transactions.length === 0) continue
      const first = transactions[0] as { hash?: unknown }
      if (typeof first?.hash === "string" && BLOCK_HASH_RE.test(first.hash)) {
        return first.hash.toLowerCase()
      }
    }
    fail(
      `no confirmed transaction found within ${maxLookback} blocks of ${fromBlock} to trace-probe`,
      "protocol",
    )
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
   * Proves the endpoint can actually support the rehearsal, and refuses it
   * otherwise.
   *
   * `debug_traceTransaction` is the one that fails QUIETLY if unchecked: the
   * capacity-deferral classifier fails closed to `reconciliation_required`
   * without it, so every capacity revert would land in reconciliation and the
   * fairness measurement would silently measure nothing rather than erroring.
   *
   * Deliberately not part of {@link PreflightChainReader}: the preflight must
   * never gain the ability to trace. This is a selection-time capability.
   */
  async qualifyProvider(
    expectedChainId: number,
    options: { now?: () => Date; probeTransactionHash?: string } = {},
  ): Promise<ProviderQualification> {
    const failures: string[] = []

    const chainId = await this.chainId()
    if (chainId !== expectedChainId) {
      failures.push(`chain id is ${chainId}, expected ${expectedChainId}`)
    }

    const block = await this.latestConfirmedBlock()
    const confirmationPolicy = this.confirmationPolicy

    // EIP-1898 probed directly, not inferred from the downgrade flag.
    let supportsBlockHashTags = true
    try {
      await this.#rpc("eth_getCode", [
        "0x0000000000000000000000000000000000000001",
        { blockHash: block.hash, requireCanonical: true },
      ])
    } catch (error) {
      if (!isCapabilityFailure(error)) throw error
      supportsBlockHashTags = false
      failures.push("endpoint does not support EIP-1898 block-hash tags")
    }

    // Trace a REAL confirmed transaction. Method recognition is not
    // entitlement: providers return -32000 for "transaction not found", but
    // also for "tracing disabled on your plan", "method restricted" and
    // "backend tracing unavailable". Only a successful, non-null structured
    // result proves tracing is actually usable.
    let supportsDebugTrace = true
    let tracedTransactionHash: string | null = null
    try {
      tracedTransactionHash = options.probeTransactionHash
        ?? (await this.#findProbeTransaction(block.number))
      const trace = await this.#rpc(
        "debug_traceTransaction",
        [tracedTransactionHash, REWARD_VAULT_TRACE_OPTIONS],
        { allowNullResult: true },
      )
      // A callTracer root carries `type` and `from`; the default opcode tracer
      // returns structLogs/gas/failed instead. Requiring the call-trace shape
      // proves the tracer production uses is the one that actually ran.
      const root = trace as { type?: unknown; from?: unknown } | null
      if (
        root === null
        || typeof root !== "object"
        || Array.isArray(root)
        || typeof root.type !== "string"
        || typeof root.from !== "string"
      ) {
        supportsDebugTrace = false
        failures.push(
          "debug_traceTransaction did not return a callTracer result for a confirmed transaction",
        )
      }
    } catch (error) {
      if (
        isCapabilityFailure(error)
        || (error instanceof RehearsalRpcError && error.kind === "rpc")
      ) {
        // The server is telling us it will not or cannot trace: unusable.
        supportsDebugTrace = false
        failures.push(
          "endpoint cannot trace a confirmed transaction"
            + " (method absent, restricted, or tracing disabled)",
        )
      } else {
        // Transport/HTTP/protocol failures are inconclusive infrastructure
        // conditions, not evidence about entitlement.
        throw error
      }
    }

    // Retention at the REQUIRED depth. Re-reading the freshly confirmed block
    // would only prove ordinary lookup: an endpoint keeping 128 blocks passes
    // that and is still useless for re-verifying the drill afterwards.
    const testedHistoricalBlock = Math.max(0, block.number - REHEARSAL_REQUIRED_RETENTION_BLOCKS)
    const historical = await this.#rpc(
      "eth_getBlockByNumber",
      [`0x${testedHistoricalBlock.toString(16)}`, false],
      { allowNullResult: true },
    )
    // Only a valid null/missing block means insufficient retention; every other
    // failure propagates out of #rpc rather than being relabelled.
    const historicalBlockReadable = historical !== null
    if (!historicalBlockReadable) {
      failures.push(
        `endpoint does not retain block ${testedHistoricalBlock}`
          + ` (${REHEARSAL_REQUIRED_RETENTION_BLOCKS} blocks / ~${REHEARSAL_REQUIRED_RETENTION_HOURS}h of history)`,
      )
    }

    const qualification: ProviderQualification = {
      host: this.host,
      chainId,
      confirmationPolicy,
      probedBlockNumber: block.number,
      probedBlockHash: block.hash,
      supportsBlockHashTags,
      supportsDebugTrace,
      tracedTransactionHash,
      historicalBlockReadable,
      rehearsalRequiredRetentionBlocks: REHEARSAL_REQUIRED_RETENTION_BLOCKS,
      testedHistoricalBlock,
      capturedAt: (options.now ?? (() => new Date()))().toISOString(),
      qualified: failures.length === 0,
      failures,
    }

    if (!qualification.qualified) {
      throw new RehearsalRpcError(
        `rehearsal rpc: provider ${this.host} is not qualified: ${failures.join("; ")}`,
        "protocol",
      )
    }
    return qualification
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
