import { createHash, createHmac, timingSafeEqual } from "node:crypto"

import { authError, providerUnavailable } from "../errors"
import type { Env } from "../../env"

const SIGNATURE = /^[0-9a-f]{64}$/
const TIMESTAMP = /^[0-9]{1,12}$/
const DEFAULT_CLOCK_WINDOW_SECONDS = 300

function signaturePayload(input: {
  method: string
  path: string
  timestamp: number
  subject: string
  body: Uint8Array
}): string {
  const bodySha256 = createHash("sha256").update(input.body).digest("hex")
  return [
    input.method.toUpperCase(),
    input.path,
    String(input.timestamp),
    input.subject,
    bodySha256,
  ].join("\n")
}

export function signDanceGraderRequest(input: {
  key: string
  method: string
  path: string
  timestamp: number
  subject: string
  body: Uint8Array
}): string {
  return createHmac("sha256", input.key)
    .update(signaturePayload(input))
    .digest("hex")
}

export function verifyDanceGraderCallback(input: {
  env: Pick<Env, "DANCE_GRADER_CALLBACK_HMAC_KEY" | "DANCE_GRADER_CALLBACK_KEY_VERSION">
  method: string
  path: string
  timestampHeader: string | undefined
  keyVersionHeader: string | undefined
  signatureHeader: string | undefined
  subject: string
  body: Uint8Array
  nowSeconds?: number
  clockWindowSeconds?: number
}): void {
  const key = input.env.DANCE_GRADER_CALLBACK_HMAC_KEY
  const expectedKeyVersion = input.env.DANCE_GRADER_CALLBACK_KEY_VERSION
  if (!key || Buffer.byteLength(key) < 32 || !expectedKeyVersion) {
    throw providerUnavailable("Dance grader callback authentication is not configured")
  }

  const timestampHeader = input.timestampHeader ?? ""
  const timestamp = Number(timestampHeader)
  const signature = input.signatureHeader ?? ""
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000)
  const clockWindow = input.clockWindowSeconds ?? DEFAULT_CLOCK_WINDOW_SECONDS
  if (
    !TIMESTAMP.test(timestampHeader)
    || !Number.isSafeInteger(timestamp)
    || Math.abs(now - timestamp) > clockWindow
    || input.keyVersionHeader !== expectedKeyVersion
    || !SIGNATURE.test(signature)
  ) {
    throw authError("Authentication failed")
  }

  const expected = signDanceGraderRequest({
    key,
    method: input.method,
    path: input.path,
    timestamp,
    subject: input.subject,
    body: input.body,
  })
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))) {
    throw authError("Authentication failed")
  }
}
