import { Contract, JsonRpcProvider, Wallet, getAddress } from "ethers"

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
]

type PublicNameQuote = {
  quote: string
  desired_label: string
  label_normalized: string
  buyer: {
    kind: "wallet"
    wallet_address: string
    chain_ref: string
  }
  price_cents: number
  expires_at: number
  payment_instructions: {
    chain: {
      chain_namespace: string
      chain_id: number
      display_name: string
    }
    token_address: string
    recipient_address: string
    amount_atomic: string
    amount_display: string
  }
}

function readArg(name: string): string | null {
  const args = process.argv.slice(2)
  const index = args.indexOf(name)
  return index === -1 ? null : args[index + 1] ?? null
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(name)
}

function optionalEnv(name: string): string {
  return String(process.env[name] ?? "").trim()
}

function jsonHeaders(extra: HeadersInit = {}): HeadersInit {
  return {
    "content-type": "application/json",
    ...extra,
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

async function requestJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, init)
  const text = await response.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = { raw: text }
    }
  }
  return { status: response.status, body }
}

function resolveRpcUrl(chainId: number): string {
  return optionalEnv("PIRATE_CHECKOUT_RPC_URL")
    || (chainId === 84532 ? optionalEnv("BASE_SEPOLIA_RPC_URL") : "")
    || (chainId === 8453 ? optionalEnv("BASE_MAINNET_RPC_URL") || optionalEnv("ETHEREUM_RPC_URL") : "")
    || (() => {
      throw new Error(`No RPC URL configured for chain ${chainId}`)
    })()
}

function parseQuote(body: unknown): PublicNameQuote {
  const value = asRecord(body)
  if (
    typeof value.quote !== "string"
    || typeof value.desired_label !== "string"
    || typeof value.label_normalized !== "string"
    || typeof value.price_cents !== "number"
    || typeof value.expires_at !== "number"
  ) {
    throw new Error(`public name quote response is malformed: ${JSON.stringify(body)}`)
  }
  return value as PublicNameQuote
}

async function sendUsdcPayment(input: {
  privateKey: string
  quote: PublicNameQuote
}): Promise<string> {
  const chainId = Number(input.quote.payment_instructions.chain.chain_id)
  const provider = new JsonRpcProvider(resolveRpcUrl(chainId), chainId)
  const wallet = new Wallet(input.privateKey, provider)
  const expectedBuyer = getAddress(input.quote.buyer.wallet_address)
  if (getAddress(wallet.address) !== expectedBuyer) {
    throw new Error(`private key wallet ${wallet.address} does not match quote buyer ${expectedBuyer}`)
  }
  const token = new Contract(input.quote.payment_instructions.token_address, ERC20_ABI, wallet)
  const tx = await token.transfer(
    input.quote.payment_instructions.recipient_address,
    BigInt(input.quote.payment_instructions.amount_atomic),
  )
  console.log(JSON.stringify({
    step: "payment_submitted",
    from: wallet.address,
    tx_hash: tx.hash,
  }, null, 2))
  await tx.wait(1)
  return tx.hash
}

async function main(): Promise<void> {
  const origin = (readArg("--origin") || "https://api-staging.pirate.sc").replace(/\/+$/, "")
  const requestedLabel = readArg("--label") || `smoke${Math.floor(Date.now() / 1000)}`
  const privateKeyEnv = readArg("--private-key-env") || "PIRATE_CHECKOUT_SMOKE_BUYER_PRIVATE_KEY"
  const privateKey = optionalEnv(privateKeyEnv)
  const wallet = readArg("--wallet")
    || (privateKey ? new Wallet(privateKey).address : "0x1111111111111111111111111111111111111111")
  const shouldClaim = hasFlag("--claim")
  const authorization = readArg("--authorization") || (hasFlag("--payment-auth") ? "Payment smoke-test" : "")

  const status = await requestJson(`${origin}/public-names/${encodeURIComponent(requestedLabel)}/status`)
  console.log(JSON.stringify({
    step: "status",
    status: status.status,
    body: status.body,
  }, null, 2))

  const quoteResponse = await requestJson(`${origin}/public-names/quotes`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      desired_label: requestedLabel,
      buyer_wallet_address: wallet,
    }),
  })
  console.log(JSON.stringify({
    step: "quote",
    status: quoteResponse.status,
    body: quoteResponse.body,
  }, null, 2))
  if (quoteResponse.status !== 200) {
    return
  }
  const quote = parseQuote(quoteResponse.body)
  if (!shouldClaim) {
    console.log(JSON.stringify({
      step: "funding_required",
      fund_wallet_address: wallet,
      required_chain: quote.payment_instructions.chain,
      required_usdc_atomic: quote.payment_instructions.amount_atomic,
      required_usdc_display: quote.payment_instructions.amount_display,
      note: `Set ${privateKeyEnv} and rerun with --claim after funding this wallet for gas and USDC.`,
    }, null, 2))
    return
  }
  if (!privateKey) {
    throw new Error(`${privateKeyEnv} is required for --claim`)
  }

  const fundingTxRef = await sendUsdcPayment({ privateKey, quote })
  const claim = await requestJson(`${origin}/public-names/claims`, {
    method: "POST",
    headers: jsonHeaders(authorization ? { authorization } : {}),
    body: JSON.stringify({
      quote: quote.quote,
      funding_tx_ref: fundingTxRef,
    }),
  })
  console.log(JSON.stringify({
    step: "claim",
    status: claim.status,
    body: claim.body,
  }, null, 2))

  const replay = await requestJson(`${origin}/public-names/claims`, {
    method: "POST",
    headers: jsonHeaders(authorization ? { authorization } : {}),
    body: JSON.stringify({
      quote: quote.quote,
      funding_tx_ref: fundingTxRef,
    }),
  })
  console.log(JSON.stringify({
    step: "claim_replay",
    status: replay.status,
    body: replay.body,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
