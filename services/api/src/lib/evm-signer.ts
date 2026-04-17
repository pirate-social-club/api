import { Wallet, getAddress } from "ethers"

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export function parseExpectedEvmAddress(raw: string | null | undefined): string | null {
  const value = String(raw || "").trim()
  if (!EVM_ADDRESS_RE.test(value)) return null
  try {
    return getAddress(value)
  } catch {
    return null
  }
}

export function deriveEvmAddressFromPrivateKey(privateKey: string): string {
  return getAddress(new Wallet(privateKey).address)
}

export function assertPrivateKeyMatchesExpectedAddress(params: {
  privateKey: string
  expectedAddress: string
  expectedField: string
}): string {
  const normalizedExpectedAddress = getAddress(params.expectedAddress)
  const derivedAddress = deriveEvmAddressFromPrivateKey(params.privateKey)
  if (derivedAddress.toLowerCase() !== normalizedExpectedAddress.toLowerCase()) {
    throw new Error(`${params.expectedField} mismatch: expected ${normalizedExpectedAddress}, derived ${derivedAddress}`)
  }
  return derivedAddress
}
