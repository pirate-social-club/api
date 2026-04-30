import { internalError, providerUnavailable } from "../errors"
import type { Env } from "../../env"

const CLAWKEY_TIMEOUT_MS = 15_000

function trimEnv(value: string | undefined): string | null {
  const trimmed = String(value ?? "").trim()
  return trimmed ? trimmed : null
}

type ClawkeyRegisterInitResponse = {
  sessionId?: unknown
  registrationUrl?: unknown
  expiresAt?: unknown
}

type ClawkeyRegisterStatusResponse = {
  status?: unknown
  deviceId?: unknown
  registration?: unknown
}

export type ClawkeyStartRegistrationResult = {
  sessionId: string
  registrationUrl: string
  expiresAt: string | null
}

export type ClawkeyRegistrationStatusResult =
  | { status: "pending" }
  | { status: "completed"; deviceId: string | null; publicKey: string | null; registeredAt: string | null }
  | { status: "expired" }
  | { status: "failed" }

export interface ClawkeyProvider {
  startRegistration(input: {
    deviceId: string
    publicKey: string
    message: string
    signature: string
    timestamp: number
  }): Promise<ClawkeyStartRegistrationResult>
  getRegistrationStatus(input: {
    sessionId: string
  }): Promise<ClawkeyRegistrationStatusResult>
}

let testOverride: ClawkeyProvider | null = null

function getBaseUrl(env: Env): string {
  return trimEnv(env.CLAWKEY_API_URL) || "https://api.ag9.ai/v1"
}

function resolveClawkeyUrl(env: Env, path: string): URL {
  const baseUrl = getBaseUrl(env)
  const normalizedPath = path.startsWith("/") ? path.slice(1) : path
  return new URL(normalizedPath, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`)
}

async function parseJsonResponse<T>(response: Response): Promise<T | null> {
  try {
    return await response.json() as T
  } catch {
    return null
  }
}

async function callJson<T>(input: {
  env: Env
  method: "GET" | "POST"
  path: string
  body?: Record<string, unknown>
}): Promise<T> {
  let url: URL
  try {
    url = resolveClawkeyUrl(input.env, input.path)
  } catch {
    throw internalError("CLAWKEY_API_URL is not a valid URL")
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CLAWKEY_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: input.method,
      headers: {
        "accept": "application/json",
        ...(input.body ? { "content-type": "application/json" } : {}),
      },
      body: input.body ? JSON.stringify(input.body) : undefined,
      signal: controller.signal,
    })
    const payload = await parseJsonResponse<T & { error?: unknown; message?: unknown }>(response)
    if (!response.ok) {
      const message = typeof payload?.message === "string"
        ? payload.message
        : `ClawKey request failed with status ${response.status}`
      if (response.status === 404) {
        throw providerUnavailable(message)
      }
      throw internalError(message)
    }
    if (!payload) {
      throw internalError("ClawKey response was not valid JSON")
    }
    return payload
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw internalError("ClawKey request timed out")
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export function getClawkeyProvider(env: Env): ClawkeyProvider {
  if (testOverride) {
    return testOverride
  }
  return {
    async startRegistration(input) {
      const payload = await callJson<ClawkeyRegisterInitResponse>({
        env,
        method: "POST",
        path: "/agent/register/init",
        body: {
          deviceId: input.deviceId,
          publicKey: input.publicKey,
          message: input.message,
          signature: input.signature,
          timestamp: input.timestamp,
        },
      })

      if (typeof payload.sessionId !== "string" || !payload.sessionId.trim()) {
        throw internalError("ClawKey did not return a sessionId")
      }
      if (typeof payload.registrationUrl !== "string" || !payload.registrationUrl.trim()) {
        throw internalError("ClawKey did not return a registrationUrl")
      }

      return {
        sessionId: payload.sessionId.trim(),
        registrationUrl: payload.registrationUrl.trim(),
        expiresAt: typeof payload.expiresAt === "string" && payload.expiresAt.trim()
          ? payload.expiresAt.trim()
          : null,
      }
    },

    async getRegistrationStatus(input) {
      const payload = await callJson<ClawkeyRegisterStatusResponse>({
        env,
        method: "GET",
        path: `/agent/register/${encodeURIComponent(input.sessionId)}/status`,
      })

      switch (payload.status) {
        case "pending":
          return { status: "pending" }
        case "expired":
          return { status: "expired" }
        case "failed":
          return { status: "failed" }
        case "completed": {
          const registration = typeof payload.registration === "object" && payload.registration != null
            ? payload.registration as Record<string, unknown>
            : null
          return {
            status: "completed",
            deviceId: typeof payload.deviceId === "string" ? payload.deviceId : null,
            publicKey: typeof registration?.publicKey === "string" ? registration.publicKey : null,
            registeredAt: typeof registration?.registeredAt === "string" ? registration.registeredAt : null,
          }
        }
        default:
          throw internalError("ClawKey returned an unknown registration status")
      }
    },
  }
}

export function setClawkeyProviderForTests(provider: ClawkeyProvider | null): void {
  testOverride = provider
}

export const __testOnly = {
  resolveClawkeyUrl,
}
