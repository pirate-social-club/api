export type AssetBalanceDescriptor = {
  assetId: string
  chainNamespace: "eip155:1" | "eip155:8453"
  standard: "native" | "erc20"
  contractAddress: string | null
  decimals: number
  symbol: string
}

const ASSETS: AssetBalanceDescriptor[] = [
  {
    assetId: "eip155:1/slip44:60",
    chainNamespace: "eip155:1",
    standard: "native",
    contractAddress: null,
    decimals: 18,
    symbol: "ETH",
  },
  {
    assetId: "eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    chainNamespace: "eip155:1",
    standard: "erc20",
    contractAddress: "0xA0b86991c6218b36c1d19d4a2e9Eb0cE3606eB48",
    decimals: 6,
    symbol: "USDC",
  },
  {
    assetId: "eip155:8453/slip44:60",
    chainNamespace: "eip155:8453",
    standard: "native",
    contractAddress: null,
    decimals: 18,
    symbol: "ETH",
  },
  {
    assetId: "eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    chainNamespace: "eip155:8453",
    standard: "erc20",
    contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    decimals: 6,
    symbol: "USDC",
  },
]

const BY_ASSET_ID = new Map(ASSETS.map((asset) => [asset.assetId, asset]))

export function resolveAssetBalanceDescriptor(value: unknown): AssetBalanceDescriptor | null {
  if (typeof value !== "string") return null
  return BY_ASSET_ID.get(value.trim().toLowerCase()) ?? null
}

export function isAtomicBalanceThreshold(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value)
}
