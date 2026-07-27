import { hexToString, isAddress, type Address, type Hex } from "viem"

export const EFP_LIST_OP_VERSION = 1
export const EFP_ADDRESS_RECORD_VERSION = 1
export const EFP_ADDRESS_RECORD_TYPE = 1

export type DecodedEfpListOp = {
  classification: "effective" | "unsupported" | "malformed"
  opVersion: number | null
  opcode: number | null
  recordVersion: number | null
  recordType: number | null
  targetAddress: Address | null
  tag: string | null
  valid: boolean
}

export type EffectiveEfpEntry = {
  followed: boolean
  tags: Set<string>
}

function byte(raw: Hex, index: number): number | null {
  const offset = 2 + index * 2
  if (raw.length < offset + 2) return null
  const value = Number.parseInt(raw.slice(offset, offset + 2), 16)
  return Number.isInteger(value) ? value : null
}

export function decodeEfpListOp(raw: Hex): DecodedEfpListOp {
  const opVersion = byte(raw, 0)
  const opcode = byte(raw, 1)
  const recordVersion = byte(raw, 2)
  const recordType = byte(raw, 3)
  const addressHex = raw.length >= 50 ? `0x${raw.slice(10, 50)}` : null
  const targetAddress = addressHex && isAddress(addressHex)
    ? addressHex.toLowerCase() as Address
    : null

  let tag: string | null = null
  if ((opcode === 3 || opcode === 4) && raw.length >= 50) {
    try {
      const decoded = hexToString(`0x${raw.slice(50)}`).trim().toLowerCase()
      tag = decoded
    } catch {
      tag = null
    }
  }

  const validHeader = opVersion === EFP_LIST_OP_VERSION
    && recordVersion === EFP_ADDRESS_RECORD_VERSION
    && recordType === EFP_ADDRESS_RECORD_TYPE
    && targetAddress !== null
  const validShape = opcode === 1 || opcode === 2
    ? raw.length >= 50
    : (opcode === 3 || opcode === 4) && tag !== null

  const valid = validHeader && validShape
  const hasCompleteHeader = opVersion != null
    && opcode != null
    && recordVersion != null
    && recordType != null
  const unsupported = hasCompleteHeader && (
    opVersion !== EFP_LIST_OP_VERSION
    || recordVersion !== EFP_ADDRESS_RECORD_VERSION
    || recordType !== EFP_ADDRESS_RECORD_TYPE
  )

  return {
    classification: valid ? "effective" : unsupported ? "unsupported" : "malformed",
    opVersion,
    opcode,
    recordVersion,
    recordType,
    targetAddress,
    tag,
    valid,
  }
}

export function applyEfpListOp(
  entries: Map<Address, EffectiveEfpEntry>,
  decoded: DecodedEfpListOp,
): void {
  if (!decoded.valid || !decoded.targetAddress || decoded.opcode == null) return

  const current = entries.get(decoded.targetAddress) ?? {
    followed: false,
    tags: new Set<string>(),
  }
  if (decoded.opcode === 1) {
    entries.set(decoded.targetAddress, { followed: true, tags: current.tags })
    return
  }
  if (decoded.opcode === 2) {
    entries.delete(decoded.targetAddress)
    return
  }
  if (decoded.tag === null) return
  if (decoded.opcode === 3) current.tags.add(decoded.tag)
  if (decoded.opcode === 4) current.tags.delete(decoded.tag)
  entries.set(decoded.targetAddress, current)
}

export function isEffectiveEfpFollow(entry: EffectiveEfpEntry | null | undefined): boolean {
  return Boolean(entry?.followed && !entry.tags.has("block") && !entry.tags.has("mute"))
}
