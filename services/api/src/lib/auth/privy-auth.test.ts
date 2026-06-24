import { describe, expect, test } from "bun:test"
import type { LinkedAccount } from "@privy-io/node"
import { getPrivyAttachmentKind } from "./privy-auth"

function walletAccount(fields: Record<string, unknown>): LinkedAccount {
  return { type: "wallet", chain_type: "ethereum", address: "0xabc", ...fields } as unknown as LinkedAccount
}

describe("getPrivyAttachmentKind", () => {
  test("classifies a Privy embedded wallet as embedded", () => {
    expect(getPrivyAttachmentKind(walletAccount({
      connector_type: "embedded",
      wallet_client_type: "privy",
    }))).toBe("embedded")
  })

  test("an injected wallet (e.g. MetaMask) is external", () => {
    expect(getPrivyAttachmentKind(walletAccount({
      connector_type: "injected",
      wallet_client_type: "metamask",
    }))).toBe("external")
  })

  test("an unknown/missing connector type is never treated as embedded", () => {
    expect(getPrivyAttachmentKind(walletAccount({}))).toBe("external")
    expect(getPrivyAttachmentKind(walletAccount({ connector_type: "embedded" }))).toBe("external")
    expect(getPrivyAttachmentKind(walletAccount({ wallet_client_type: "privy" }))).toBe("external")
  })
})
