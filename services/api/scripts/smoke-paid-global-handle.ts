import { Contract, JsonRpcProvider, Wallet } from "ethers"
import { SignJWT } from "jose"

const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
]

type ChallengeDetails = {
  quote: string
  price_cents: number
  expires_at?: number
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

function requireEnv(name: string): string {
  const value = String(process.env[name] ?? "").trim()
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

function optionalEnv(name: string): string {
  return String(process.env[name] ?? "").trim()
}

function jsonHeaders(token?: string): HeadersInit {
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  }
}

async function requestJson(url: string, init: RequestInit): Promise<{ status: number; body: unknown }> {
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {}
}

async function mintUpstreamJwt(input: {
  wallet: string
  subject: string
}): Promise<string> {
  const issuer = requireEnv("AUTH_UPSTREAM_JWT_ISSUER")
  const audience = requireEnv("AUTH_UPSTREAM_JWT_AUDIENCE")
  const secret = requireEnv("AUTH_UPSTREAM_JWT_SHARED_SECRET")

  return await new SignJWT({ wallet_address: input.wallet })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(input.subject)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(new TextEncoder().encode(secret))
}

function resolveRpcUrl(chainId: number): string {
  return optionalEnv("PIRATE_CHECKOUT_RPC_URL")
    || (chainId === 84532 ? optionalEnv("BASE_SEPOLIA_RPC_URL") : "")
    || (chainId === 8453 ? optionalEnv("BASE_MAINNET_RPC_URL") || optionalEnv("ETHEREUM_RPC_URL") : "")
    || (() => {
      throw new Error(`No RPC URL configured for chain ${chainId}`)
    })()
}

async function sendUsdcPayment(input: {
  privateKey: string
  details: ChallengeDetails
}): Promise<string> {
  const chainId = Number(input.details.payment_instructions.chain.chain_id)
  const provider = new JsonRpcProvider(resolveRpcUrl(chainId), chainId)
  const wallet = new Wallet(input.privateKey, provider)
  const token = new Contract(input.details.payment_instructions.token_address, ERC20_ABI, wallet)
  const tx = await token.transfer(
    input.details.payment_instructions.recipient_address,
    BigInt(input.details.payment_instructions.amount_atomic),
  )
  console.log(JSON.stringify({
    step: "payment_submitted",
    from: wallet.address,
    tx_hash: tx.hash,
  }))
  await tx.wait(1)
  return tx.hash
}

async function main(): Promise<void> {
  const origin = (readArg("--origin") || "https://api-staging.pirate.sc").replace(/\/+$/, "")
  const requestedLabel = readArg("--label") || `smoke${Math.floor(Date.now() / 1000)}`
  const subject = readArg("--sub") || `paid-handle-smoke-${requestedLabel}`
  const privateKeyEnv = readArg("--private-key-env") || "PIRATE_CHECKOUT_SMOKE_BUYER_PRIVATE_KEY"
  const privateKey = optionalEnv(privateKeyEnv)
  const wallet = readArg("--wallet")
    || (privateKey ? new Wallet(privateKey).address : "0x1111111111111111111111111111111111111111")
  const shouldClaim = hasFlag("--claim")

  const upstreamJwt = await mintUpstreamJwt({ wallet, subject })
  const session = await requestJson(`${origin}/auth/session/exchange`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      proof: {
        type: "jwt_based_auth",
        jwt: upstreamJwt,
      },
    }),
  })
  const sessionBody = asRecord(session.body)
  const accessToken = typeof sessionBody.access_token === "string" ? sessionBody.access_token : ""
  if (session.status !== 200 || !accessToken) {
    throw new Error(`session exchange failed: ${JSON.stringify(session.body)}`)
  }

  const challenge = await requestJson(`${origin}/profiles/me/global-handle/x402-claim`, {
    method: "POST",
    headers: jsonHeaders(accessToken),
    body: JSON.stringify({ desired_label: requestedLabel }),
  })
  const challengeBody = asRecord(challenge.body)
  const details = asRecord(challengeBody.details) as Partial<ChallengeDetails>
  console.log(JSON.stringify({
    step: "challenge",
    status: challenge.status,
    code: challengeBody.code ?? null,
    wallet,
    label: requestedLabel,
    quote: details.quote ?? null,
    price_cents: details.price_cents ?? null,
    chain: details.payment_instructions?.chain ?? null,
    token_address: details.payment_instructions?.token_address ?? null,
    recipient_address: details.payment_instructions?.recipient_address ?? null,
    amount_atomic: details.payment_instructions?.amount_atomic ?? null,
    amount_display: details.payment_instructions?.amount_display ?? null,
    expires_at: details.expires_at ?? null,
  }, null, 2))

  if (challenge.status !== 402) {
    return
  }
  if (!shouldClaim) {
    console.log(JSON.stringify({
      step: "funding_required",
      fund_wallet_address: wallet,
      required_chain: details.payment_instructions?.chain ?? null,
      required_usdc_atomic: details.payment_instructions?.amount_atomic ?? null,
      required_usdc_display: details.payment_instructions?.amount_display ?? null,
      note: `Set ${privateKeyEnv} in Infisical and rerun with --claim after funding this wallet for gas and USDC.`,
    }, null, 2))
    return
  }
  if (!privateKey) {
    throw new Error(`${privateKeyEnv} is required for --claim`)
  }
  if (!details.quote || !details.payment_instructions) {
    throw new Error("payment challenge is missing quote or payment instructions")
  }

  const fundingTxRef = await sendUsdcPayment({
    privateKey,
    details: details as ChallengeDetails,
  })
  const claim = await requestJson(`${origin}/profiles/me/global-handle/x402-claim`, {
    method: "POST",
    headers: jsonHeaders(accessToken),
    body: JSON.stringify({
      quote: details.quote,
      funding_tx_ref: fundingTxRef,
    }),
  })
  console.log(JSON.stringify({
    step: "claim",
    status: claim.status,
    body: claim.body,
  }, null, 2))
  const replay = await requestJson(`${origin}/profiles/me/global-handle/x402-claim`, {
    method: "POST",
    headers: jsonHeaders(accessToken),
    body: JSON.stringify({
      quote: details.quote,
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
