// Minimal Worker entry used only by the Phase 3 workerd integration test.
//
// It re-exports the REAL KaraokeSessionRuntimeDO and mounts the REAL gateway
// route (token verification, origin allowlist, DO forwarding) so the test
// exercises production code paths against real workerd — not a hand-rolled
// Durable Object context. The full application Worker (src/index.ts) is
// deliberately avoided here so the integration test does not need every
// binding the production app declares.

import { Hono } from "hono"

import type { Env } from "../../src/env"
import karaokeSessions from "../../src/routes/karaoke-sessions"

export { KaraokeSessionRuntimeDO } from "../../src/lib/karaoke/session-do"
// Shared integration-test worker bundle: also re-export the booking operator signing coordinator DO
// so its workerd-isolate tests can bind it (real input gates, RPC concurrency, SQLite storage).
export { OperatorSigningCoordinatorDO } from "../../src/lib/bookings/operator-signing-coordinator-do"

const app = new Hono<{ Bindings: Env }>()
app.route("/karaoke/sessions", karaokeSessions)

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx)
  },
}
