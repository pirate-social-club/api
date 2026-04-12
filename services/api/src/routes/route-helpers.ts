import type { Context } from "hono"
import { badRequestError, errorResponse } from "../lib/errors"
import type { Env } from "../types"

export type AppRouteContext = Context<{ Bindings: Env }>
export type AppRouteHandler = (c: AppRouteContext) => Promise<Response>

export function handleRoute(handler: AppRouteHandler): AppRouteHandler {
  return async (c) => {
    try {
      return await handler(c)
    } catch (error) {
      const response = errorResponse(error)
      return new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { "content-type": "application/json" },
      })
    }
  }
}

export function requireRouteParam(value: string | undefined, label: string): string {
  if (!value) {
    throw badRequestError(`Missing ${label}`)
  }
  return value
}
