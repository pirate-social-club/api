# Pirate API — Agent Notes

## Repository Boundary

`/home/t42/Documents/pirate-workspace` is a workspace directory, not this Git repo. This repo root is `/home/t42/Documents/pirate-workspace/api`.

Run API git commands from this directory. The sibling `web/` and `core/` directories are separate Git repositories and must be committed independently.

## Staging Worker

`pirate-api-staging` is a shared fixture: deploying replaces whatever bundle is
there, and a web release redeploys it at the pinned SHA. Before deploying to it,
read and update `services/api/docs/runbooks/staging-worker-ownership.md`.

## Default Checks

Use focused checks first:

```bash
rtk bun run check:hygiene
rtk bun run --cwd services/api check
rtk bun test services/api/tests/routes/path/to/touched.test.ts
```

The API service, contracts, CLI, agent connector, and issuer checks use the TypeScript 7 native preview compiler (`tsgo`). They are faster than the old `tsc` checks, but the repo-level `rtk bun run check` still chains multiple package checks; use it only when broad repo verification is needed or explicitly requested.

For focused route work, run the smallest touched route suite after typecheck. For CLI changes, run `rtk bun run check:cli` after `services/cli` dependencies are installed. Use full `agent-ci` only after the focused checks are green.

## Route Tests

- Keep route groups to at most three primary test files: `routes.test.ts`, `auth.test.ts`, and `lifecycle.test.ts`.
- Add `lifecycle.test.ts` only for non-trivial state transitions.
- Keep group-local helpers in `test-helpers.ts` only after two files in that group need them.
- Do not create new global test helpers for one route group.
- Keep `ROUTE_COVERAGE.md` aligned with mounted routes. `rtk bun run check:hygiene` fails when a mounted route file is missing from the map.

## Code Quality

- Do not duplicate auth, signing, config, path, or validation helpers.
- Extract on the second real caller.
- Avoid compatibility shims unless they have an owner, a removal condition, and a dated TODO.
- Generated contracts are generated output; do not hand-edit them.
- Generated/vendor files are exempt from size cleanup. Split large service/domain files on next meaningful touch when they make review harder.

## API Design Standards

New and touched public API surfaces should follow the Stripe-style resource pattern unless an existing migration plan says otherwise.

- Resources return a canonical read-only `id` field and a canonical read-only `object` field. Do not introduce primary-key fields such as `community_id`, `post_id`, `verification_session_id`, or resource-specific aliases on new response objects.
- Reference fields should be named after the referenced object, not suffixed with `_id`, so they can later expand from an ID string to an object without a field rename. Prefer `community`, `post`, `user`, `agent`, `listing` over `community_id`, `post_id`, `user_id`, `agent_id`, `listing_id` for new public fields.
- Creation timestamps use `created`, represented as Unix seconds. Other datetimes use Unix seconds with action-oriented names such as `expires_at`, `accepted_at`, `verified_at`, or `finalized_at`. Pure calendar dates may remain `YYYY-MM-DD` strings.
- Do not add generic `updated` or `updated_at` fields to public resources. Prefer explicit state transition timestamps or typed events.
- Monetary amounts should use integer smallest units such as cents, or string decimals with a `_decimal` suffix. Do not expose JSON floating-point values for money, percentages, ratios, or scores that need decimal precision.
- Prefer enums over booleans for policy, mode, and lifecycle fields that may need additional states.
- Update endpoints use `POST`, accept optional fields for partial updates, and return the updated resource. Do not add new `PATCH` or `PUT` update endpoints.
- Custom actions use `GET`, `POST`, or `DELETE` only, and the custom method name must be a single path segment after the resource path, for example `POST /agents/{id}/refresh_credential`.
- Use `DELETE` only for final, immediate deletion. Soft deletion, removal, cancellation, archiving, and reversible state changes should be modeled as `POST` custom methods and return the updated resource.
- Delete responses must use the deleted-resource shape: `{ id, object, deleted: true }`.
- List responses must be bounded and include cursor pagination metadata such as `next_cursor` and/or `has_more`, unless the collection is explicitly documented as small and hard-bounded.
- Prefer one canonical list/retrieve endpoint per resource. If a derived public or agent-discovery surface must exist, document which endpoint is canonical.
- OpenAPI operations must not define the same path parameter both inline and by `$ref`. Use the shared `$ref` form when available.

When touching older endpoints that do not yet follow these rules, either move them toward this shape or leave a clear migration note. Do not add compatibility aliases unless they have an owner, a removal condition, and a dated TODO.
