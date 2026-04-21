export type CourtyardRegistryConfig = {
  chainNamespace: "eip155:137"
  contractAddress: string
  label: string
}

export const COURTYARD_REGISTRIES: CourtyardRegistryConfig[] = [
  {
    chainNamespace: "eip155:137",
    contractAddress: "0x251BE3A17Af4892035C37ebf5890F4a4D889dcAD",
    label: "Courtyard Polygon Registry",
  },
]

export const DEFAULT_COURTYARD_API_URL = "https://api.courtyard.io"
