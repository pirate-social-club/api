# Community bookings boundary audit — 2026-07-11

## Decision requested

Make global Postgres bookings (`/bookings/*`, `src/lib/bookings/*`) the only
booking storage and service boundary. Treat `/communities/:communityId/*booking*`
as legacy compatibility surface: first remove its per-community D1 fallback,
then retire the aliases after an observed deprecation window.

Do not remove the mounted community routes as a dead-code or Knip cleanup. They
are live HTTP endpoints, and their removal is an API compatibility decision.

## Evidence

- `src/routes/communities.ts` imports and mounts
  `registerCommunityBookingsRoutes`.
- `src/routes/communities-bookings.ts` is 712 lines; the canonical global
  `src/routes/bookings.ts` is 489 lines. Both implement availability, holds,
  quote/confirm, booking reads, lifecycle actions, sessions, and settlement
  review.
- Canonical Web `origin/main` calls only `/bookings/*`. No production Web source
  calls a community-prefixed booking API. Community-prefixed URLs found in Web
  are UI routes, not API requests.
- The generated OpenAPI document exposes global booking paths and does not expose
  community-prefixed booking paths. External consumers still need telemetry or
  access-log confirmation; absence from Web and OpenAPI is not proof that none
  exist.
- The community route test suite directly exercises the legacy endpoints, so
  their code and tests are internally reachable by design.

## Current routing behavior

For normal user booking operations, `tryGlobalBookings`:

1. uses the global implementation when `CONTROL_PLANE_DATABASE_URL` is
   PostgreSQL and the global schema exists;
2. catches PostgreSQL `42P01` (or matching missing-table messages); and
3. silently falls back to the per-community implementation.

Before attempting the global operation, each community-prefixed handler calls
`getResolvedCommunityRouteContext`. Production therefore pays community
identifier, authorization, and repository-routing work for an operation whose
authoritative data is global.

The three community-prefixed settlement-review endpoints do not use the global
path at all. They still read and mutate the per-community booking tables. Their
global counterparts exist under `/bookings/settlement-review/*` and
`/bookings/:bookingId/settlement-review/*`.

## Risks

### Split authority

Missing global schema is treated as a reason to write or read a different
database, not as a failed deployment. A partially migrated environment can
therefore create bookings in per-community D1 while other clients use global
Postgres. Settlement-review endpoints deepen the split because the community
variants remain D1-only even when the global schema is healthy.

### Money-path duplication

Two implementations independently maintain holds, payment confirmation,
lifecycle transitions, attendance, settlement evaluation, custody, and operator
signing. Fixes can land on one boundary without reaching the other. This is a
high-risk DRY violation because the duplicated behavior moves money.

### Performance

Community-prefixed calls resolve community context before global dispatch.
Canonical global routes avoid that redundant routing work. The exception-based
schema probe is not expensive in a healthy production environment, but the
compatibility route itself adds work and complexity on every legacy request.

### Security and operability

The settlement-review community paths bypass normal community authentication in
`communities.ts`, then authenticate an operator credential inside each handler.
This is fail-closed today, but duplicates the global operator-auth boundary and
creates another surface that must remain aligned. Silent schema fallback also
makes deployment errors harder to observe.

## Recommended migration

1. Add metrics for community-prefixed booking requests, labeled by route and
   caller identity class. Do not log authorization values or request bodies.
2. Make a product/API compatibility call using observed traffic. Publish a
   deprecation window if any external caller remains.
3. Remove `tryGlobalBookings` fallback behavior. Community-prefixed compatibility
   handlers, if retained, must call only the global booking services and fail
   loudly when the global schema is unavailable.
4. Redirect or rewrite the three settlement-review aliases to their global
   implementations so there is one operator-auth and storage boundary.
5. Add `Deprecation` and `Sunset` headers to retained aliases and document the
   canonical replacement paths.
6. After the window, unmount `registerCommunityBookingsRoutes`, delete
   `src/routes/communities-bookings.ts`, then let reachability analysis identify
   the per-community booking subtree and tests that became genuinely unused.
7. Keep `src/lib/bookings/*`, global `/bookings/*`, and
   `@pirate/bookings-domain`.

## Explicit non-decisions

- This audit does not authorize deleting live endpoints.
- It does not classify `src/lib/communities/bookings/*` as dead while the routes,
  cron/evaluator paths, or Durable Object exports still reach it.
- It does not infer absence of external consumers solely from the Web repository.
- It does not mix this architecture change with the mechanical 112/205 export
  cleanup.
