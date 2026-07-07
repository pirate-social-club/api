import type { Context } from "hono"

export type ServerTimingRecorder = {
  record: (name: string, durationMs: number) => void
  time: <T>(name: string, fn: () => Promise<T>) => Promise<T>
  timeSync: <T>(name: string, fn: () => T) => T
  writeHeader: () => void
}

function sanitizeTimingName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64) || "step"
}

function formatDuration(durationMs: number): string {
  return Math.max(0, Math.round(durationMs * 10) / 10).toFixed(1)
}

export function createServerTimingRecorder(c: Context): ServerTimingRecorder {
  const entries: string[] = []

  const record = (name: string, durationMs: number) => {
    entries.push(`${sanitizeTimingName(name)};dur=${formatDuration(durationMs)}`)
  }

  return {
    record,
    time: async (name, fn) => {
      const startedAt = performance.now()
      try {
        return await fn()
      } finally {
        record(name, performance.now() - startedAt)
      }
    },
    timeSync: (name, fn) => {
      const startedAt = performance.now()
      try {
        return fn()
      } finally {
        record(name, performance.now() - startedAt)
      }
    },
    writeHeader: () => {
      if (entries.length > 0) {
        c.header("Server-Timing", entries.join(", "))
      }
    },
  }
}
