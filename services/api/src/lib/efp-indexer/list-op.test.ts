import { describe, expect, test } from "bun:test"
import { type Address, encodePacked, stringToHex } from "viem"

import { applyEfpListOp, decodeEfpListOp, isEffectiveEfpFollow } from "./list-op"

const TARGET = "0xd69e335d0b803f7dac27c130db90f5808a30b559" as Address

function op(opcode: number, tag?: string) {
  return encodePacked(
    tag == null
      ? ["uint8", "uint8", "uint8", "uint8", "address"]
      : ["uint8", "uint8", "uint8", "uint8", "address", "bytes"],
    tag == null
      ? [1, opcode, 1, 1, TARGET]
      : [1, opcode, 1, 1, TARGET, stringToHex(tag)],
  )
}

describe("decodeEfpListOp", () => {
  test("decodes address-record add and remove operations", () => {
    expect(decodeEfpListOp(op(1))).toEqual({
      classification: "effective",
      opVersion: 1,
      opcode: 1,
      recordVersion: 1,
      recordType: 1,
      targetAddress: TARGET,
      tag: null,
      valid: true,
    })
    expect(decodeEfpListOp(op(2)).valid).toBe(true)
  })

  test("normalizes tags and rejects malformed or unsupported records", () => {
    expect(decodeEfpListOp(op(3, "MUTE")).tag).toBe("mute")
    expect(decodeEfpListOp("0x010101" as const).valid).toBe(false)
    expect(decodeEfpListOp(
      encodePacked(["uint8", "uint8", "uint8", "uint8", "address"], [2, 1, 1, 1, TARGET]),
    ).classification).toBe("unsupported")
    expect(decodeEfpListOp(`${op(2)}0000000000000000`).classification).toBe("malformed")
  })
})

describe("applyEfpListOp", () => {
  test("replays add, tags, untag, and remove in canonical order", () => {
    const entries = new Map()
    applyEfpListOp(entries, decodeEfpListOp(op(1)))
    expect(isEffectiveEfpFollow(entries.get(TARGET))).toBe(true)

    applyEfpListOp(entries, decodeEfpListOp(op(3, "block")))
    expect(isEffectiveEfpFollow(entries.get(TARGET))).toBe(false)

    applyEfpListOp(entries, decodeEfpListOp(op(4, "block")))
    expect(isEffectiveEfpFollow(entries.get(TARGET))).toBe(true)

    applyEfpListOp(entries, decodeEfpListOp(op(2)))
    expect(entries.has(TARGET)).toBe(false)

    applyEfpListOp(entries, decodeEfpListOp(op(1)))
    expect(isEffectiveEfpFollow(entries.get(TARGET))).toBe(true)
  })
})
