import { describe, expect, test } from "bun:test"
import {
  DECK_IMPORT_PLAINTEXT_RETENTION_MS,
  parseDeckImportClaimRef,
} from "./deck-import-retention"

describe("deck import plaintext retention", () => {
  test("parses only the durable deck/import identity", () => {
    const importKey = "a".repeat(64)
    expect(parseDeckImportClaimRef(`ldk_fixture:${importKey}`)).toEqual({
      deckId: "ldk_fixture",
      importKey,
    })
    expect(parseDeckImportClaimRef(`ldk_fixture:${importKey.toUpperCase()}`)).toBeNull()
    expect(parseDeckImportClaimRef("ldk_fixture:not-a-hash")).toBeNull()
    expect(parseDeckImportClaimRef(`ldk_fixture:${importKey}:extra`)).toBeNull()
  })

  test("pins the seven-day raw import retention window", () => {
    expect(DECK_IMPORT_PLAINTEXT_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
})
