const encoder = new TextEncoder()

export function bytesToHex(bytes: Uint8Array): string {
  let hex = ""
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0")
  }
  return hex
}

export function toArrayBuffer(value: ArrayBuffer | Uint8Array | string): ArrayBuffer {
  if (typeof value === "string") {
    return encoder.encode(value).buffer.slice(0)
  }

  if (value instanceof Uint8Array) {
    const buffer = new ArrayBuffer(value.byteLength)
    new Uint8Array(buffer).set(value)
    return buffer
  }

  return value
}

export async function sha256Hex(value: ArrayBuffer | Uint8Array | string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(value))
  return bytesToHex(new Uint8Array(digest))
}
