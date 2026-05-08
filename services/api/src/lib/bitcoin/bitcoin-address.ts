import { sha256 } from "@noble/hashes/sha2"
import { bytesToHex } from "@noble/hashes/utils"

export const BITCOIN_MAINNET_NAMESPACE = "bip122:000000000019d6689c085ae165831e93"
export const BITCOIN_TESTNET_NAMESPACE = "bip122:000000000933ea01ad0ee984209779ba"
export const BITCOIN_REGTEST_NAMESPACE = "bip122:0f9188f13cb7b2c71f2a335e3a4fc328"

type BitcoinNetwork = "mainnet" | "testnet" | "regtest"
type BitcoinAddressKind = "p2pkh" | "p2sh" | "p2wpkh" | "p2wsh" | "p2tr"

export type ParsedBitcoinAddress = {
  address: string
  addressNormalized: string
  chainNamespace: string
  network: BitcoinNetwork
  kind: BitcoinAddressKind
  scriptPubkeyHex: string
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
const BECH32_ALPHABET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
const BECH32_GENERATORS = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

function networkNamespace(network: BitcoinNetwork): string {
  if (network === "mainnet") return BITCOIN_MAINNET_NAMESPACE
  if (network === "testnet") return BITCOIN_TESTNET_NAMESPACE
  return BITCOIN_REGTEST_NAMESPACE
}

function hash256(bytes: Uint8Array): Uint8Array {
  return sha256(sha256(bytes))
}

function decodeBase58(value: string): Uint8Array | null {
  let result = 0n
  for (const char of value) {
    const index = BASE58_ALPHABET.indexOf(char)
    if (index < 0) {
      return null
    }
    result = result * 58n + BigInt(index)
  }

  const bytes: number[] = []
  while (result > 0n) {
    bytes.push(Number(result & 0xffn))
    result >>= 8n
  }
  bytes.reverse()

  let leadingZeros = 0
  for (const char of value) {
    if (char !== "1") break
    leadingZeros += 1
  }

  return new Uint8Array([...Array(leadingZeros).fill(0), ...bytes])
}

function decodeBase58Check(value: string): Uint8Array | null {
  const decoded = decodeBase58(value)
  if (!decoded || decoded.length < 5) {
    return null
  }
  const payload = decoded.slice(0, -4)
  const checksum = decoded.slice(-4)
  const expected = hash256(payload).slice(0, 4)
  for (let index = 0; index < 4; index += 1) {
    if (checksum[index] !== expected[index]) {
      return null
    }
  }
  return payload
}

function bech32Polymod(values: number[]): number {
  let chk = 1
  for (const value of values) {
    const top = chk >> 25
    chk = ((chk & 0x1ffffff) << 5) ^ value
    for (let index = 0; index < 5; index += 1) {
      if (((top >> index) & 1) === 1) {
        chk ^= BECH32_GENERATORS[index] ?? 0
      }
    }
  }
  return chk
}

function bech32HrpExpand(hrp: string): number[] {
  const high = [...hrp].map((char) => char.charCodeAt(0) >> 5)
  const low = [...hrp].map((char) => char.charCodeAt(0) & 31)
  return [...high, 0, ...low]
}

function decodeBech32(value: string): { hrp: string; version: number; program: Uint8Array; checksum: "bech32" | "bech32m" } | null {
  if (value !== value.toLowerCase() && value !== value.toUpperCase()) {
    return null
  }
  const normalized = value.toLowerCase()
  const separator = normalized.lastIndexOf("1")
  if (separator < 1 || separator + 7 > normalized.length) {
    return null
  }

  const hrp = normalized.slice(0, separator)
  const data = [...normalized.slice(separator + 1)].map((char) => BECH32_ALPHABET.indexOf(char))
  if (data.some((index) => index < 0)) {
    return null
  }

  const polymod = bech32Polymod([...bech32HrpExpand(hrp), ...data])
  const checksum = polymod === 1 ? "bech32" : polymod === 0x2bc830a3 ? "bech32m" : null
  if (!checksum) {
    return null
  }

  const payload = data.slice(0, -6)
  const version = payload[0]
  if (version == null || version > 16) {
    return null
  }
  const program = convertBits(payload.slice(1), 5, 8, false)
  if (!program || program.length < 2 || program.length > 40) {
    return null
  }
  if (version === 0 && checksum !== "bech32") {
    return null
  }
  if (version !== 0 && checksum !== "bech32m") {
    return null
  }
  return { hrp, version, program: new Uint8Array(program), checksum }
}

function convertBits(data: number[], fromBits: number, toBits: number, pad: boolean): number[] | null {
  let accumulator = 0
  let bits = 0
  const maxValue = (1 << toBits) - 1
  const maxAccumulator = (1 << (fromBits + toBits - 1)) - 1
  const result: number[] = []

  for (const value of data) {
    if (value < 0 || (value >> fromBits) !== 0) {
      return null
    }
    accumulator = ((accumulator << fromBits) | value) & maxAccumulator
    bits += fromBits
    while (bits >= toBits) {
      bits -= toBits
      result.push((accumulator >> bits) & maxValue)
    }
  }

  if (pad) {
    if (bits > 0) {
      result.push((accumulator << (toBits - bits)) & maxValue)
    }
  } else if (bits >= fromBits || ((accumulator << (toBits - bits)) & maxValue) !== 0) {
    return null
  }

  return result
}

function pushWitnessProgram(version: number, program: Uint8Array): string {
  const versionOpcode = version === 0 ? "00" : (0x50 + version).toString(16).padStart(2, "0")
  const length = program.length.toString(16).padStart(2, "0")
  return `${versionOpcode}${length}${bytesToHex(program)}`
}

export function parseBitcoinAddress(value: unknown): ParsedBitcoinAddress | null {
  if (typeof value !== "string") {
    return null
  }
  const address = value.trim()
  if (!address) {
    return null
  }

  const bech32 = decodeBech32(address)
  if (bech32) {
    let network: BitcoinNetwork | null = null
    if (bech32.hrp === "bc") {
      network = "mainnet"
    } else if (bech32.hrp === "tb") {
      network = "testnet"
    } else if (bech32.hrp === "bcrt") {
      network = "regtest"
    }
    if (!network) {
      return null
    }

    if (bech32.version === 0 && bech32.program.length === 20) {
      return {
        address,
        addressNormalized: address.toLowerCase(),
        chainNamespace: networkNamespace(network),
        network,
        kind: "p2wpkh",
        scriptPubkeyHex: pushWitnessProgram(bech32.version, bech32.program),
      }
    }
    if (bech32.version === 0 && bech32.program.length === 32) {
      return {
        address,
        addressNormalized: address.toLowerCase(),
        chainNamespace: networkNamespace(network),
        network,
        kind: "p2wsh",
        scriptPubkeyHex: pushWitnessProgram(bech32.version, bech32.program),
      }
    }
    if (bech32.version === 1 && bech32.program.length === 32) {
      return {
        address,
        addressNormalized: address.toLowerCase(),
        chainNamespace: networkNamespace(network),
        network,
        kind: "p2tr",
        scriptPubkeyHex: pushWitnessProgram(bech32.version, bech32.program),
      }
    }
    return null
  }

  const payload = decodeBase58Check(address)
  if (!payload || payload.length !== 21) {
    return null
  }
  const version = payload[0]
  const hash = payload.slice(1)
  if (version === 0x00 || version === 0x6f) {
    const network: BitcoinNetwork = version === 0x00 ? "mainnet" : "testnet"
    return {
      address,
      addressNormalized: address,
      chainNamespace: networkNamespace(network),
      network,
      kind: "p2pkh",
      scriptPubkeyHex: `76a914${bytesToHex(hash)}88ac`,
    }
  }
  if (version === 0x05 || version === 0xc4) {
    const network: BitcoinNetwork = version === 0x05 ? "mainnet" : "testnet"
    return {
      address,
      addressNormalized: address,
      chainNamespace: networkNamespace(network),
      network,
      kind: "p2sh",
      scriptPubkeyHex: `a914${bytesToHex(hash)}87`,
    }
  }

  return null
}
