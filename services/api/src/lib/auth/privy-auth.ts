import { PrivyClient, verifyAccessToken, type LinkedAccount } from "@privy-io/node"
import { createRemoteJWKSet, importSPKI, type JWTVerifyGetKey } from "jose"
import { authError } from "../errors"
import { dedupeStrings, normalizeAddress } from "../helpers"
import { parseBitcoinAddress } from "../bitcoin/bitcoin-address"
import type { Env } from "../../env"
import type { UpstreamIdentity, UpstreamWalletIdentity, WalletAttachmentKind } from "../../types"

const DEFAULT_PRIVY_AUTH_API_URL = "https://auth.privy.io"
const ETHEREUM_CHAIN_TYPE = "ethereum"
const BITCOIN_SEGWIT_CHAIN_TYPE = "bitcoin-segwit"
const BITCOIN_TAPROOT_CHAIN_TYPE = "bitcoin-taproot"
const LINKED_WALLET_TYPE = "wallet"
const PRIVY_EMBEDDED_CONNECTOR_TYPE = "embedded"
const PRIVY_EMBEDDED_WALLET_CLIENT_TYPE = "privy"

// Classify a Privy linked wallet account. Privy embedded EVM wallets carry
// connector_type: "embedded" and wallet_client_type: "privy"; anything else (or missing
// metadata) is treated conservatively as external and is never eligible for embedded-first
// identity-wallet initialization.
export function getPrivyAttachmentKind(account: LinkedAccount): WalletAttachmentKind {
  const connectorType = "connector_type" in account
    ? (account as { connector_type?: unknown }).connector_type
    : undefined
  const walletClientType = "wallet_client_type" in account
    ? (account as { wallet_client_type?: unknown }).wallet_client_type
    : undefined
  if (connectorType === PRIVY_EMBEDDED_CONNECTOR_TYPE && walletClientType === PRIVY_EMBEDDED_WALLET_CLIENT_TYPE) {
    return "embedded"
  }
  return "external"
}

let cachedJwks:
  | { apiUrl: string; appId: string; verificationKey: string | null; jwks: JWTVerifyGetKey }
  | null = null
let cachedPrivyClient:
  | { apiUrl: string; appId: string; appSecret: string; client: PrivyClient }
  | null = null
let testOverride:
  | ((params: { env: Env; accessToken: string; walletAddress?: string | null }) => Promise<UpstreamIdentity>)
  | null = null

function collectEthereumWallets(linkedAccounts: LinkedAccount[]): string[] {
  return dedupeStrings(linkedAccounts.flatMap((account) => {
    if (account.type !== LINKED_WALLET_TYPE) return []
    if (!("chain_type" in account) || account.chain_type !== ETHEREUM_CHAIN_TYPE) return []
    const normalized = normalizeAddress(account.address)
    return normalized ? [normalized] : []
  }))
}

function collectWalletIdentities(linkedAccounts: LinkedAccount[]): UpstreamWalletIdentity[] {
  const wallets = new Map<string, UpstreamWalletIdentity>()
  for (const account of linkedAccounts) {
    if (account.type !== LINKED_WALLET_TYPE || !("chain_type" in account)) {
      continue
    }

    if (account.chain_type === ETHEREUM_CHAIN_TYPE) {
      const normalized = normalizeAddress(account.address)
      if (!normalized) {
        continue
      }
      const wallet = {
        chainNamespace: "eip155:1",
        walletAddress: normalized,
        walletAddressNormalized: normalized,
        scriptPubkeyHex: null,
        attachmentKind: getPrivyAttachmentKind(account),
      }
      wallets.set(`${wallet.chainNamespace}:${wallet.walletAddressNormalized}`, wallet)
      continue
    }

    if (account.chain_type === BITCOIN_SEGWIT_CHAIN_TYPE || account.chain_type === BITCOIN_TAPROOT_CHAIN_TYPE) {
      const parsed = parseBitcoinAddress(account.address)
      if (!parsed) {
        continue
      }
      const wallet: UpstreamWalletIdentity = {
        chainNamespace: parsed.chainNamespace,
        walletAddress: parsed.address,
        walletAddressNormalized: parsed.addressNormalized,
        scriptPubkeyHex: parsed.scriptPubkeyHex,
        attachmentKind: "external",
      }
      wallets.set(`${wallet.chainNamespace}:${wallet.walletAddressNormalized}`, wallet)
    }
  }

  return [...wallets.values()]
}

async function getPrivyVerificationKey(env: Env): Promise<JWTVerifyGetKey | CryptoKey> {
  const appId = String(env.PRIVY_APP_ID || "").trim()
  if (!appId) throw authError("PRIVY_APP_ID is not configured")

  const apiUrl = String(env.PRIVY_API_URL || "").trim() || DEFAULT_PRIVY_AUTH_API_URL
  const verificationKey = String(env.PRIVY_JWT_VERIFICATION_KEY || "").trim() || null
  if (verificationKey) {
    return await importSPKI(verificationKey, "ES256")
  }

  if (
    cachedJwks
    && cachedJwks.appId === appId
    && cachedJwks.apiUrl === apiUrl
    && cachedJwks.verificationKey === verificationKey
  ) {
    return cachedJwks.jwks
  }

  const jwks = createRemoteJWKSet(new URL(`${apiUrl}/api/v1/apps/${appId}/jwks.json`))
  cachedJwks = { apiUrl, appId, verificationKey, jwks }
  return jwks
}

function getPrivyClient(env: Env): PrivyClient {
  const appId = String(env.PRIVY_APP_ID || "").trim()
  const appSecret = String(env.PRIVY_APP_SECRET || "").trim()
  const apiUrl = String(env.PRIVY_API_URL || "").trim() || DEFAULT_PRIVY_AUTH_API_URL
  if (!appId) throw authError("PRIVY_APP_ID is not configured")
  if (!appSecret) throw authError("PRIVY_APP_SECRET is not configured")

  if (
    cachedPrivyClient
    && cachedPrivyClient.appId === appId
    && cachedPrivyClient.appSecret === appSecret
    && cachedPrivyClient.apiUrl === apiUrl
  ) {
    return cachedPrivyClient.client
  }

  const client = new PrivyClient({ appId, appSecret, ...(apiUrl ? { apiUrl } : {}) })
  cachedPrivyClient = { apiUrl, appId, appSecret, client }
  return client
}

export async function verifyPrivyAccessProof(params: {
  env: Env
  accessToken: string
  walletAddress?: string | null
}): Promise<UpstreamIdentity> {
  if (testOverride) {
    return await testOverride(params)
  }

  const appId = String(params.env.PRIVY_APP_ID || "").trim()
  if (!appId) {
    throw authError("PRIVY_APP_ID is not configured")
  }

  const verified = await verifyAccessToken({
    access_token: params.accessToken,
    app_id: appId,
    verification_key: await getPrivyVerificationKey(params.env),
  }).catch(() => {
    throw authError("Authentication failed")
  })

  const client = getPrivyClient(params.env)
  const user = await client.users()._get(verified.user_id).catch(() => {
    throw authError("Authentication failed")
  })
  const walletAddresses = collectEthereumWallets(user.linked_accounts)
  const wallets = collectWalletIdentities(user.linked_accounts)
  const requestedWallet = normalizeAddress(params.walletAddress)
  if (requestedWallet && !walletAddresses.includes(requestedWallet)) {
    throw authError("Privy proof does not include the requested wallet")
  }

  return {
    provider: "privy",
    providerSubject: user.id,
    providerUserRef: user.id,
    walletAddresses,
    // Only an explicitly requested wallet is treated as a selection. Auth must never pick a
    // wallet from incidental ordering — the identity wallet is initialized embedded-first and
    // changed only via explicit user action. (See initializePrimaryWalletIfNeeded.)
    selectedWalletAddress: requestedWallet ?? null,
    wallets,
    selectedWallet: requestedWallet
      ? wallets.find((wallet) => wallet.chainNamespace === "eip155:1" && wallet.walletAddressNormalized === requestedWallet) ?? null
      : null,
  }
}

export function setPrivyAccessProofVerifierForTests(
  override:
    | ((params: { env: Env; accessToken: string; walletAddress?: string | null }) => Promise<UpstreamIdentity>)
    | null,
): void {
  testOverride = override
}
