import type { Context } from "hono"

export function getWaitUntil(c: Context): ((promise: Promise<void>) => void) | undefined {
  try {
    const executionCtx = c.executionCtx
    return (promise) => executionCtx.waitUntil(promise)
  } catch {
    return undefined
  }
}
