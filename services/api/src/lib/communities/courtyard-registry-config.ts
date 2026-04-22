export type CourtyardRegistryConfig = {
  chainNamespace: "eip155:1" | "eip155:137"
  contractAddress: string
  label: string
}

export const COURTYARD_REGISTRIES: CourtyardRegistryConfig[] = [
  {
    chainNamespace: "eip155:1",
    contractAddress: "0xd4ac3CE8e1E14CD60666D49AC34Ff2d2937cF6FA",
    label: "Courtyard Ethereum Registry",
  },
  {
    chainNamespace: "eip155:137",
    contractAddress: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
    label: "Courtyard Polygon Registry",
  },
]

export const DEFAULT_COURTYARD_API_URL = "https://api.courtyard.io"
