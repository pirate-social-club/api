export const AGENT_ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000
export const AGENT_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const AGENT_PAIRING_CODE_TTL_MS = 10 * 60 * 1000

const AGENT_PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

export function parseIsoMs(iso: string): number | null {
  const parsed = new Date(iso).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

export function buildOpaqueToken(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`
}

function buildPairingCodeSegment(length: number): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(length))
  let output = ""
  for (let index = 0; index < length; index += 1) {
    output += AGENT_PAIRING_CODE_ALPHABET[randomBytes[index]! % AGENT_PAIRING_CODE_ALPHABET.length]
  }
  return output
}

export function buildPairingCode(): string {
  return `PIR-${buildPairingCodeSegment(4)}-${buildPairingCodeSegment(4)}`
}

export function plusMs(baseMs: number, deltaMs: number): string {
  return new Date(baseMs + deltaMs).toISOString()
}
