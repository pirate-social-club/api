import type { ErrorResponse } from "@pirate/api-contracts"

export class PirateHttpError extends Error {
  status: number
  body: ErrorResponse | Record<string, unknown> | null

  constructor(status: number, body: ErrorResponse | Record<string, unknown> | null) {
    const message =
      (body && typeof body === "object" && "message" in body && typeof body.message === "string" && body.message) ||
      `Request failed with status ${status}`
    super(message)
    this.status = status
    this.body = body
  }
}

export async function apiRequest<T>(input: {
  baseUrl: string
  path: string
  method?: "GET" | "POST" | "PUT" | "PATCH"
  accessToken?: string | null
  body?: unknown
}): Promise<T> {
  const response = await fetch(`${trimTrailingSlash(input.baseUrl)}${input.path}`, {
    method: input.method ?? "GET",
    headers: {
      ...(input.accessToken ? { Authorization: `Bearer ${input.accessToken}` } : {}),
      ...(input.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
  })

  const text = await response.text()
  const parsed = text ? safeJsonParse(text) : null
  if (!response.ok) {
    throw new PirateHttpError(response.status, parsed)
  }
  return parsed as T
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return null
  }
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value
}
