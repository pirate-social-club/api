import { badRequestError } from "../../errors"
import { packCursor, unpackCursor } from "../../cursor-codec"

type CommerceListCursor = {
  created_at: string
  id: string
}

export function encodeCommerceListCursor(cursor: CommerceListCursor): string {
  return packCursor(cursor)
}

export function decodeCommerceListCursor(cursor: string | null | undefined): CommerceListCursor | null {
  if (!cursor) {
    return null
  }
  try {
    const parsed = unpackCursor<{
      created_at?: unknown
      id?: unknown
    }>(cursor)
    if (typeof parsed.created_at !== "string" || !parsed.created_at.trim()) {
      throw new Error("invalid cursor")
    }
    if (typeof parsed.id !== "string" || !parsed.id.trim()) {
      throw new Error("invalid cursor")
    }
    return {
      created_at: parsed.created_at,
      id: parsed.id,
    }
  } catch {
    throw badRequestError("Invalid commerce cursor")
  }
}
