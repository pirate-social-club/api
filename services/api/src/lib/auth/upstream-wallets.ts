import type { UpstreamIdentity, UpstreamWalletIdentity } from "../../types"

const ETHEREUM_MAINNET_NAMESPACE = "eip155:1"

function walletKey(wallet: Pick<UpstreamWalletIdentity, "chainNamespace" | "walletAddressNormalized">): string {
  return `${wallet.chainNamespace}:${wallet.walletAddressNormalized}`
}

function makeEthereumWalletIdentity(walletAddress: string): UpstreamWalletIdentity {
  return {
    chainNamespace: ETHEREUM_MAINNET_NAMESPACE,
    walletAddress,
    walletAddressNormalized: walletAddress,
    scriptPubkeyHex: null,
    // Synthetic identities materialized from a bare address list (e.g. JWT wallet claims)
    // carry no Privy embedded metadata, so they are external by definition.
    attachmentKind: "external",
  }
}

export function listIdentityWallets(identity: UpstreamIdentity): UpstreamWalletIdentity[] {
  const wallets = [
    ...(identity.wallets ?? []),
    ...identity.walletAddresses.map(makeEthereumWalletIdentity),
  ]
  const deduped = new Map<string, UpstreamWalletIdentity>()
  for (const wallet of wallets) {
    const chainNamespace = wallet.chainNamespace.trim()
    const walletAddress = wallet.walletAddress.trim()
    const walletAddressNormalized = wallet.walletAddressNormalized.trim()
    if (!chainNamespace || !walletAddress || !walletAddressNormalized) {
      continue
    }
    const normalizedWallet = {
      ...wallet,
      chainNamespace,
      walletAddress,
      walletAddressNormalized,
      scriptPubkeyHex: wallet.scriptPubkeyHex ?? null,
    }
    deduped.set(walletKey(normalizedWallet), normalizedWallet)
  }
  return [...deduped.values()]
}

// Resolve ONLY an explicit selection (a requested wallet, or a provider-supplied
// selected_wallet_address such as JWT's). Unlike the previous helper, this intentionally has
// NO ordering fallback — incidental wallet order must never determine the identity wallet.
export function resolveExplicitSelectedIdentityWallet(identity: UpstreamIdentity): UpstreamWalletIdentity | null {
  const wallets = listIdentityWallets(identity)
  if (wallets.length === 0) {
    return null
  }

  if (identity.selectedWallet) {
    const selectedKey = walletKey(identity.selectedWallet)
    const selected = wallets.find((wallet) => walletKey(wallet) === selectedKey)
    if (selected) {
      return selected
    }
  }

  if (identity.selectedWalletAddress) {
    const selected = wallets.find((wallet) => (
      wallet.chainNamespace === ETHEREUM_MAINNET_NAMESPACE
        && wallet.walletAddressNormalized === identity.selectedWalletAddress
    ))
    if (selected) {
      return selected
    }
  }

  return null
}

// Embedded-first candidate for one-time identity-wallet initialization: the Privy embedded
// EVM wallet. Deterministic tie-break by normalized address so provider ordering is irrelevant.
export function pickEmbeddedEvmIdentityWallet(identity: UpstreamIdentity): UpstreamWalletIdentity | null {
  const embedded = listIdentityWallets(identity).filter((wallet) => (
    wallet.attachmentKind === "embedded" && wallet.chainNamespace === ETHEREUM_MAINNET_NAMESPACE
  ))
  if (embedded.length === 0) {
    return null
  }
  return [...embedded].sort((a, b) => a.walletAddressNormalized.localeCompare(b.walletAddressNormalized))[0]
}
