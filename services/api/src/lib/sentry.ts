import type { CloudflareOptions } from "@sentry/cloudflare"
import { captureException, honoIntegration } from "@sentry/cloudflare"
import type { Env } from "../env"

const REDACT_HEADERS = new Set([
  "authorization",
  "cookie",
  "x-admin-token",
  "x-admin-as-user-id",
  "x-agent-connection-token",
  "x-pirate-session-id",
  "x-pirate-anonymous-id",
])

export function captureScheduledError(env: Env, error: unknown, task: string): void {
  if (!env.SENTRY_DSN) return
  captureException(error, { tags: { scheduled_task: task } })
}

export function makeSentryOptions(env: Env): CloudflareOptions {
  return {
    dsn: env.SENTRY_DSN,
    environment: env.ENVIRONMENT || "development",
    sendDefaultPii: false,
    integrations: [
      honoIntegration({
        shouldHandleError(error) {
          return !error.status || error.status >= 500
        },
      }),
    ],
    tracesSampleRate: env.ENVIRONMENT === "production" ? 0.2 : 1.0,
    beforeSend(event) {
      if (event.request?.headers && typeof event.request.headers === "object") {
        const safe: Record<string, string> = {}
        for (const [key, value] of Object.entries(event.request.headers)) {
          safe[key] = REDACT_HEADERS.has(key.toLowerCase()) ? "[redacted]" : value
        }
        event.request.headers = safe
      }
      return event
    },
  }
}
