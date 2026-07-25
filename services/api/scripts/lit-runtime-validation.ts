/**
 * Lit Chipotle runtime validation spike.
 *
 * Proves or refutes the four runtime assumptions the rewards vault design rests
 * on, before any action CID is pinned:
 *
 *   1. what identifier `Lit.Actions.getPrivateKey({ pkpId })` actually accepts
 *   2. which ethers surface the action runtime exposes
 *   3. TEE clock skew against the action's deadline window
 *   4. whether a real signed transaction survives the byte-exact verifier
 *
 * Probes run independently so one failure cannot mask the others.
 *
 * SECRET DISCIPLINE: the account key is read from the environment and is never
 * printed, echoed, or included in a report. No probe returns a private key out
 * of the TEE — the getPrivateKey probe derives an address inside the action and
 * returns only that.
 *
 * Usage:
 *   infisical run --env=dev --path=/spikes/lit-runtime-validation -- \
 *     bun services/api/scripts/lit-runtime-validation.ts validate
 */

import { buildRewardVaultLitAction } from "../src/lib/rewards/reward-vault-lit-action"
import {
  verifySignedRewardVaultTransaction,
  type RewardVaultTransactionInput,
} from "../src/lib/rewards/reward-vault-transaction"

const BASE_URL = process.env.LIT_SPIKE_BASE_URL ?? "https://api.chipotle.litprotocol.com/core/v1"
const API_KEY = process.env.LIT_SPIKE_API_KEY ?? ""

// Base Sepolia. The vault need not exist yet: the verifier checks that the
// signed transaction matches the expected fields, not that the destination is
// deployed. That lets probe 4 run before the rehearsal vault is deployed.
const CHAIN_ID = 84532
const PLACEHOLDER_VAULT = "0x000000000000000000000000000000000000beef"

type ProbeResult = {
  probe: string
  question: string
  passed: boolean
  finding: string
  detail?: unknown
}

class SpikeError extends Error {}

/** Redacts anything key-shaped before a failure message is allowed near stdout. */
function scrub(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value)
  if (!API_KEY) return text
  return text.split(API_KEY).join("<redacted-account-key>")
}

async function executeAction(
  code: string,
  jsParams: Record<string, unknown> | null,
): Promise<{ response: unknown; logs: string; hasError: boolean }> {
  const response = await fetch(`${BASE_URL}/lit_action`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify({ code, js_params: jsParams }),
  })
  if (response.status === 402) {
    throw new SpikeError(
      "HTTP 402: the account has no credits. Top up with the $5 minimum package before running probes.",
    )
  }
  if (!response.ok) {
    throw new SpikeError(`lit_action returned HTTP ${response.status}: ${scrub(await response.text())}`)
  }
  const body = (await response.json()) as { response: unknown; logs?: string; has_error?: boolean }
  return { response: body.response, logs: body.logs ?? "", hasError: body.has_error === true }
}

async function createWallet(): Promise<string> {
  const response = await fetch(`${BASE_URL}/create_wallet`, {
    method: "POST",
    headers: { "x-api-key": API_KEY },
  })
  if (response.status === 402) {
    throw new SpikeError("HTTP 402: create_wallet needs credits. Top up before running probes.")
  }
  if (!response.ok) {
    throw new SpikeError(`create_wallet returned HTTP ${response.status}: ${scrub(await response.text())}`)
  }
  const body = (await response.json()) as { wallet_address?: string }
  if (!body.wallet_address) throw new SpikeError("create_wallet returned no wallet_address")
  return body.wallet_address
}

/**
 * Probe 2 — which ethers surface exists. Runs first because probes 3 and 4
 * depend on knowing whether this runtime is v5-shaped or v6-shaped.
 */
async function probeEthersSurface(): Promise<ProbeResult> {
  const code = `
    async function main() {
      const present = (path) => {
        try { return typeof path() } catch (_) { return "throws" }
      }
      return {
        ethersType: typeof ethers,
        version: (typeof ethers !== "undefined" && ethers.version) || null,
        utils_getAddress: present(() => ethers.utils.getAddress),
        utils_Interface: present(() => ethers.utils.Interface),
        utils_serializeTransaction: present(() => ethers.utils.serializeTransaction),
        v6_getAddress: present(() => ethers.getAddress),
        v6_Interface: present(() => ethers.Interface),
        v6_Transaction: present(() => ethers.Transaction),
        Wallet: present(() => ethers.Wallet),
        getPrivateKey: present(() => Lit.Actions.getPrivateKey),
        signAndCombineEcdsa: present(() => Lit.Actions.signAndCombineEcdsa),
      }
    }
  `
  const { response, hasError, logs } = await executeAction(code, null)
  const detail = response as Record<string, unknown> | null
  const v5 = detail?.utils_getAddress === "function" && detail?.utils_Interface === "function"
  return {
    probe: "ethers-surface",
    question: "Does the action runtime expose the ethers v5 API the action assumes?",
    passed: !hasError && v5,
    finding: hasError
      ? `action errored: ${logs}`
      : v5
        ? "ethers v5 utils surface present as assumed"
        : "ethers v5 utils surface ABSENT — the action must be rewritten against the real surface",
    detail,
  }
}

/** Probe 3 — TEE clock skew against the deadline window. */
async function probeTeeClock(): Promise<ProbeResult> {
  const code = `async function main() { return { teeNowMs: Date.now() } }`
  const before = Date.now()
  const { response, hasError, logs } = await executeAction(code, null)
  const after = Date.now()
  const teeNow = Number((response as { teeNowMs?: unknown } | null)?.teeNowMs)
  if (hasError || !Number.isFinite(teeNow)) {
    return {
      probe: "tee-clock",
      question: "Is TEE clock skew small enough for the action's deadline window?",
      passed: false,
      finding: `action did not return a usable clock reading: ${logs}`,
    }
  }
  // Skew is only meaningful outside the request window; inside it, it is noise.
  const roundTripMs = after - before
  const skewMs = teeNow < before ? teeNow - before : teeNow > after ? teeNow - after : 0
  const withinTolerance = Math.abs(skewMs) <= 30_000
  return {
    probe: "tee-clock",
    question: "Is TEE clock skew small enough for the action's deadline window?",
    passed: withinTolerance,
    finding: withinTolerance
      ? `TEE clock within tolerance (skew beyond request window: ${skewMs}ms)`
      : `TEE clock skew ${skewMs}ms exceeds the 30s tolerance — deadlines will misbehave`,
    detail: { skewMs, roundTripMs, localBefore: before, localAfter: after, teeNow },
  }
}

/**
 * Probe 1 — what `pkpId` actually accepts. Candidates are tried independently.
 *
 * The action derives an address from the retrieved key and returns ONLY that
 * address; the private key never leaves the TEE.
 */
async function probeGetPrivateKeyIdentifier(pkpAddress: string): Promise<ProbeResult> {
  const candidates: Record<string, unknown> = {
    checksumAddress: pkpAddress,
    lowercaseAddress: pkpAddress.toLowerCase(),
    numericZero: 0,
    stringZero: "0",
    derivationPath: "m/44'/60'/0'/0/0",
  }
  const code = `
    async function main() {
      const out = {}
      for (const [label, candidate] of Object.entries(candidates)) {
        try {
          const key = await Lit.Actions.getPrivateKey({ pkpId: candidate })
          // Never return the key. Derive an address and return only that.
          let derived = null
          try {
            derived = new ethers.Wallet(key).address
          } catch (_) {
            derived = "<key retrieved, address derivation failed>"
          }
          out[label] = { accepted: true, derivedAddress: derived }
        } catch (error) {
          out[label] = { accepted: false, error: String(error && error.message ? error.message : error) }
        }
      }
      return out
    }
  `
  const { response, hasError, logs } = await executeAction(code, { candidates, expected: pkpAddress })
  const detail = (response ?? {}) as Record<string, { accepted?: boolean; derivedAddress?: string }>
  const accepted = Object.entries(detail)
    .filter(([, value]) => value?.accepted === true)
    .map(([label]) => label)
  const addressFormWorks = detail.checksumAddress?.accepted === true
    || detail.lowercaseAddress?.accepted === true
  const correctWallet = Object.values(detail).some(
    (value) => value?.derivedAddress?.toLowerCase() === pkpAddress.toLowerCase(),
  )
  return {
    probe: "getPrivateKey-identifier",
    question: "Does getPrivateKey({ pkpId }) accept the PKP address, as the action assumes?",
    passed: !hasError && addressFormWorks && correctWallet,
    finding: hasError
      ? `action errored: ${logs}`
      : accepted.length === 0
        ? "NO candidate identifier was accepted — the action cannot retrieve a signing key as written"
        : addressFormWorks && correctWallet
          ? `address form accepted and resolves to the expected wallet (accepted: ${accepted.join(", ")})`
          : `accepted forms (${accepted.join(", ")}) do NOT match the assumed address form or resolve to a different wallet`,
    detail,
  }
}

/** Probe 4 — real action, real verifier, byte-exact round trip. */
async function probeSignedTransactionRoundTrip(pkpAddress: string): Promise<ProbeResult> {
  const input: RewardVaultTransactionInput = {
    effectKind: "reward_cashout",
    effectId: "spike_runtime_validation_effect",
    recipient: "0x000000000000000000000000000000000000dEaD",
    amount: 10_000n,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    policyVersion: 1n,
    vaultAddress: PLACEHOLDER_VAULT,
    signerAddress: pkpAddress,
    chainId: CHAIN_ID,
    nonce: 0,
    gas: {
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      gasLimit: 200_000n,
    },
  }

  const code = buildRewardVaultLitAction({
    vaultAddress: input.vaultAddress,
    signerAddress: input.signerAddress,
    chainId: input.chainId,
    policyVersion: input.policyVersion,
    maxDeadlineSeconds: 3_600,
    maxFeePerGasWei: input.gas.maxFeePerGas,
    maxPriorityFeePerGasWei: input.gas.maxPriorityFeePerGas,
    maxGasLimit: input.gas.gasLimit,
  })

  const { response, hasError, logs } = await executeAction(code, {
    method: "pay",
    effectId: input.effectId,
    recipient: input.recipient,
    amount: input.amount.toString(),
    deadline: input.deadline.toString(),
    policyVersion: input.policyVersion.toString(),
    nonce: input.nonce,
    gas: {
      maxFeePerGas: input.gas.maxFeePerGas.toString(),
      maxPriorityFeePerGas: input.gas.maxPriorityFeePerGas.toString(),
      gasLimit: input.gas.gasLimit.toString(),
    },
  })

  if (hasError) {
    return {
      probe: "signed-tx-round-trip",
      question: "Does the real action's signed transaction pass the byte-exact verifier?",
      passed: false,
      finding: `the real action failed inside the TEE: ${logs}`,
      detail: { response },
    }
  }

  const signedTx = (response as { signedTx?: unknown } | null)?.signedTx
  if (typeof signedTx !== "string") {
    return {
      probe: "signed-tx-round-trip",
      question: "Does the real action's signed transaction pass the byte-exact verifier?",
      passed: false,
      finding: "the action returned no signedTx string — the response adapter contract does not hold",
      detail: { response },
    }
  }

  try {
    const verified = verifySignedRewardVaultTransaction(signedTx, input)
    return {
      probe: "signed-tx-round-trip",
      question: "Does the real action's signed transaction pass the byte-exact verifier?",
      passed: true,
      finding: "signed transaction verified byte-exact against the expected vault call",
      detail: { txHash: verified.txHash },
    }
  } catch (error) {
    return {
      probe: "signed-tx-round-trip",
      question: "Does the real action's signed transaction pass the byte-exact verifier?",
      passed: false,
      finding: `verifier REJECTED the signed transaction: ${scrub(error)}`,
    }
  }
}

async function main(): Promise<void> {
  if (!API_KEY) {
    throw new SpikeError(
      "LIT_SPIKE_API_KEY is not set. Run under `infisical run --env=dev --path=/spikes/lit-runtime-validation`.",
    )
  }

  const results: ProbeResult[] = []
  results.push(await probeEthersSurface())
  results.push(await probeTeeClock())

  // Prefer a PKP minted out-of-band by the account owner, so the usage key
  // running these probes never needs `can_create_pkps`.
  const provided = process.env.LIT_SPIKE_PKP_ADDRESS?.trim()
  const pkpAddress = provided && provided.length > 0 ? provided : await createWallet()
  console.log(
    `PKP wallet for this run: ${pkpAddress}${provided ? " (provided)" : " (created by this run)"}`,
  )
  results.push(await probeGetPrivateKeyIdentifier(pkpAddress))
  results.push(await probeSignedTransactionRoundTrip(pkpAddress))

  console.log("\n=== Lit runtime validation ===")
  for (const result of results) {
    console.log(`\n[${result.passed ? "PASS" : "FAIL"}] ${result.probe}`)
    console.log(`  Q: ${result.question}`)
    console.log(`  → ${result.finding}`)
    if (result.detail !== undefined) {
      console.log(`  detail: ${JSON.stringify(result.detail)}`)
    }
  }

  const failed = results.filter((result) => !result.passed)
  console.log(
    `\n${results.length - failed.length}/${results.length} probes passed.`
      + (failed.length > 0
        ? ` CID pinning stays blocked until these are resolved: ${failed.map((r) => r.probe).join(", ")}.`
        : " All four runtime assumptions hold; CID pinning is unblocked."),
  )
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(scrub(error))
  process.exitCode = 1
})
