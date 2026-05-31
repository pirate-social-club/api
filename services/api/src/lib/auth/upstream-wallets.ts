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

export function resolveSelectedIdentityWallet(identity: UpstreamIdentity): UpstreamWalletIdentity | null {
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

  return wallets.find((wallet) => wallet.chainNamespace === ETHEREUM_MAINNET_NAMESPACE) ?? wallets[0] ?? null
}
