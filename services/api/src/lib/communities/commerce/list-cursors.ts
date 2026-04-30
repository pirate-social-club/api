import { badRequestError } from "../../errors"

type CommerceListCursor = {
  created_at: string
  id: string
}

export function encodeCommerceListCursor(cursor: CommerceListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url")
}

export function decodeCommerceListCursor(cursor: string | null | undefined): CommerceListCursor | null {
  if (!cursor) {
    return null
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      created_at?: unknown
      id?: unknown
    }
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
