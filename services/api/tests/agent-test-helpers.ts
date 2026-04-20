import { createHash, generateKeyPairSync, sign as signWithPrivateKey, type KeyObject } from "node:crypto"
import type { AgentChallenge } from "../src/lib/agents/types"

export function createSignedAgentChallenge(input?: {
  message?: string
  timestamp?: number
  deviceId?: string
}): {
  privateKey: KeyObject
  publicKeyPem: string
  publicKeyDerBase64: string
  deviceId: string
  timestamp: number
  challenge: AgentChallenge
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519")
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString()
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" })
  const publicKeyDerBase64 = publicKeyDer.toString("base64")
  const message = input?.message ?? "agent-challenge"
  const timestamp = input?.timestamp ?? Date.now()
  const deviceId = input?.deviceId ?? `device_${createHash("sha256").update(publicKeyDer).digest("hex").slice(0, 16)}`
  const signature = signWithPrivateKey(
    null,
    Buffer.from(message, "utf8"),
    privateKey,
  ).toString("base64")

  return {
    privateKey,
    publicKeyPem,
    publicKeyDerBase64,
    deviceId,
    timestamp,
    challenge: {
      device_id: deviceId,
      message,
      signature,
      public_key: publicKeyDerBase64,
      timestamp,
    },
  }
}
