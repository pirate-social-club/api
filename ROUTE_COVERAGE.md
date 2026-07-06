# API Route Coverage

## Purpose

This is the current route-to-test inventory for `services/api`.

It is not a claim that the suite is stable.
It only maps the live route surface to where direct route-level coverage appears to exist today.

## Route Surface

Mounted in `services/api/src/index.ts`:

- `/auth`
- `/oauth`
- `/analytics`
- `/bookings`
- `/__version`
- non-production `/__debug/sentry-error`
- `/` for discovery routes
- `/` for agent routes
- `/admin/bot-users`
- `/admin/debug`
- `/community-media`
- `/comments`
- `/communities`
- `/feed`
- `/geo`
- `/jobs`
- `/karaoke/sessions`
- `/notifications`
- `/royalties`
- `/posts`
- `/public-agents`
- `/public-comments`
- `/public-communities`
- `/public-names`
- `/public-namespaces`
- `/public-posts`
- `/public-profiles`
- `/profile-media`
- `/users`
- `/onboarding`
- `/profiles`
- `/telegram`
- `/wallet-identities`
- `/` for verification routes
- `/health`
- `/mcp`

## Coverage Map

| Route Group | Main Route File | Primary Test Files | Coverage Status | Notes |
| --- | --- | --- | --- | --- |
| `/analytics/*` | `src/routes/analytics.ts` | `tests/routes/analytics-routes.test.ts` | direct | Covers client analytics ingestion, allowlisted properties, and unsupported event rejection. |
| `/admin/bot-users` | `src/routes/bot-users.ts` | `tests/routes/bot-users-routes.test.ts` | direct | Bot-user management endpoints. |
| `/admin/debug/post-pipeline` | `src/routes/debug-pipeline.ts` | `tests/routes/debug-pipeline-routes.test.ts` | direct | Admin-only diagnostic endpoint for post translation/summary pipeline state. |
| discovery routes under `/` | `src/routes/discovery.ts` | `tests/routes/discovery-routes.test.ts` | direct | Covers well-known discovery responses. |
| `/auth/session/exchange` | `src/routes/auth.ts` | `tests/routes/auth/auth-routes.test.ts` | direct | Also exercised by many other route suites for setup. |
| `/oauth/device_*` | `src/routes/oauth.ts` | `tests/routes/auth/auth-routes.test.ts` | direct | Covers Freedom Desktop device authorization start, pending poll, user approval, access-token issuance, and refresh-token rotation. |
| `/users/me` | `src/routes/users.ts` | `tests/routes/auth/auth-routes.test.ts` | direct | Covered via auth flow tests. |
| `/onboarding/*` | `src/routes/onboarding.ts` | `tests/routes/onboarding-routes.test.ts`, `tests/routes/auth/auth-routes.test.ts` | direct | Includes status, reddit verification, reddit imports. |
| verification routes under `/` | `src/routes/verification.ts` | `tests/routes/verification/verification-routes.test.ts` | direct | Heavy route coverage, but suite stability is currently weak. |
| `/agents/*` | `src/routes/agents.ts` | `tests/routes/agents/agents-routes.test.ts`, `tests/agent-action-proof.test.ts` | direct | Covers ownership, handles, credentials, connection tokens, and action proof helpers. |
| `/public-agents/:handleLabel` | `src/routes/public-agents.ts` | `tests/routes/agents/agents-routes.test.ts` | direct | Covered alongside agent handle flows. |
| `/__version` | `src/index.ts` | `tests/routes/communities/community-admin-routes.test.ts` | direct | Covers build metadata and community provision operator version passthrough. |
| `/communities` create, settings, assistant, and membership paths | `src/routes/communities.ts`, `src/routes/communities-create-routes.ts`, `src/routes/communities-settings-routes.ts`, `src/routes/communities-assistant-routes.ts`, `src/routes/communities-membership-routes.ts` | `tests/routes/communities/community-routes.test.ts`, `tests/routes/communities/community-provisioning-routes.test.ts`, `tests/routes/communities/community-provisioning-recovery-routes.test.ts`, `tests/routes/communities/community-membership-routes.test.ts`, `tests/routes/communities/community-membership-gates-routes.test.ts`, `tests/routes/communities/community-gender-and-request-gates-routes.test.ts`, `tests/routes/communities/community-settings-routes.test.ts`, `tests/routes/communities/community-settings-gates-routes.test.ts`, `tests/routes/communities/community-assistant-routes.test.ts`, `tests/routes/communities/community-assistant-chat-routes.test.ts`, `tests/routes/communities/community-post-routes.test.ts`, `tests/routes/communities/community-agent-post-routes.test.ts`, moderation and gates suites | direct | Split route files exist, but broad behavior is still distributed across several large suites. |
| `/communities/:communityId/handles/*` and `/communities/:communityId/handle-policy` | `src/routes/communities-handles-routes.ts` | `tests/routes/communities/community-handle-routes.test.ts` | direct | Covers current handle lookup/status, policy reads and writes, owner reserve/revoke/list, quote validation, free and paid claims, disabled claims, protocol issuance preconditions, and generated protocol issuance response fields. |
| `/communities/:communityId/posts/*` | `src/routes/communities-content-routes.ts` | `tests/routes/communities/community-post-routes.test.ts`, `tests/routes/communities/community-agent-post-routes.test.ts`, `tests/routes/communities/community-anonymous-post-routes.test.ts` | direct | Covers post create/list/comment attachment, anonymous posting, link preview admin override, author self-delete, and post lifecycle edge cases. |
| `/communities/:communityId/posts/:postId/study*` and `/communities/:communityId/posts/:postId/streaks/leaderboard` | `src/routes/communities-study-routes.ts` | `tests/routes/communities/community-study-routes.test.ts`, `tests/lib/posts/post-study-service.test.ts`, `tests/integration/shard-write.integration.ts` | direct/service/integration | Covers study route registration and the streak leaderboard route directly; streak writes have service coverage and a real D1 shard write-path regression. |
| `/communities/*` commerce paths | `src/routes/communities-commerce.ts` | `tests/routes/song-artifacts/song-artifact-routes.test.ts`, `tests/routes/song-artifacts/song-artifact-locked-routes.test.ts`, `tests/routes/song-artifacts/song-artifact-donation-routes.test.ts`, `tests/community-commerce-*.test.ts` | direct/partial | Asset/listing/purchase coverage exists; Story/CDR route paths are mapped in `STORY_CDR_PATHS.md`. |
| `/communities/*/live-rooms` | `src/routes/communities-live-rooms.ts` | `tests/routes/communities/community-live-room-routes.test.ts` | direct | Covers v2 live-room creation, setlist/allocation validation, attach preconditions, and cancellation. Runtime/DO token issuance is intentionally not wired yet. |
| `/communities/:communityId/telegram-bot/*`, `/communities/:communityId/telegram-chat/*`, `/telegram/setup-intents/complete`, `/telegram/webhook`, and `/telegram/community-bots/:webhookId/webhook` | `src/routes/communities-telegram-routes.ts`, `src/routes/telegram.ts` | `tests/routes/communities/community-telegram-routes.test.ts` | direct | Covers owner bot token save/revoke without token leakage, community-bot webhook secret validation, owner setup intent creation, bot-secret-backed completion, linked chat settings update, unlinking, non-owner denial, channel rejection, legacy webhook secret validation, `/start` request-chat setup, `chat_shared` completion, group assistant routing, and join-request gate handling. |
| `/communities/*/song-artifact-*` | `src/routes/communities-song-artifacts.ts` | `tests/routes/song-artifacts/song-artifact-routes.test.ts`, `tests/routes/song-artifacts/song-artifact-catalog-*.test.ts`, `tests/routes/song-artifacts/song-artifact-locked-routes.test.ts`, `tests/routes/song-artifacts/song-artifact-donation-routes.test.ts`, `tests/routes/communities/community-live-room-routes.test.ts` | direct | Covers song uploads, bundles, picker-style listing, locked assets, catalog sync, donation-sidecar paths, and local fallback paths. |
| `/comments/*` | `src/routes/comments.ts` | `tests/routes/comments/comments-routes.test.ts`, `tests/routes/comments/comments-read-routes.test.ts`, `tests/comment-service*.test.ts` | direct | Covers create/read/replies/context/vote/delete through route and service tests. |
| `/public-comments/*` | `src/routes/public-comments.ts` | `tests/routes/comments/comments-read-routes.test.ts` | direct | Covers public post comments and public replies. |
| `/feed/home` | `src/routes/feed.ts` | `tests/routes/feed-routes.test.ts`, `src/lib/feed/home-feed-service.test.ts`, broader public-post tests | direct | Route coverage includes the empty-feed/community-summary path; service tests cover ranking helpers. |
| public-read entrypoint app | `src/routes/public-read-app.ts` | `tests/routes/feed-routes.test.ts`, `tests/routes/communities/public-communities-routes.test.ts`, `tests/routes/comments/comments-read-routes.test.ts` | direct | Groups cacheable public read routes for the inner WorkerEntrypoint boundary. |
| `/geo/search` | `src/routes/geo.ts` | `tests/routes/geo-routes.test.ts` | direct | Covers authenticated Geoapify autocomplete, normalized place payloads, validation errors, missing provider configuration, and optional live smoke coverage. |
| `/jobs/:jobId` | `src/routes/jobs.ts` | `tests/routes/jobs-posts-routes.test.ts`, `tests/routes/communities/community-routes.test.ts` | direct | Dedicated jobs coverage now exists, with broader assertions still present in community flows. |
| `/karaoke/sessions/:sessionId/websocket` | `src/routes/karaoke-sessions.ts` | `tests/routes/karaoke-sessions.test.ts` | direct | Covers the WebSocket gateway: upgrade requirement, allowed-origin enforcement, gateway token verification (session binding, expiry, future-issued, TTL cap, tampered signature, unsupported protocol version), and 503 when the runtime namespace is unbound. Runtime/DO WebSocket forwarding is exercised via the token-validation surface. |
| `/notifications/*` | `src/routes/notifications.ts` | `tests/routes/notifications-routes.test.ts` | direct | Covers auth requirement, summary, tasks, feed, mark-read, and dismiss-task. |
| `/royalties/*` | `src/routes/royalties.ts` | `tests/routes/royalties-routes.test.ts` | direct | Covers claimable royalties, activity, claims listing, and claim recording. |
| `/posts/:postId` and `/posts/:postId/vote` | `src/routes/posts.ts` | `tests/routes/jobs-posts-routes.test.ts`, `tests/routes/communities/community-routes.test.ts` | direct | Dedicated post read/vote coverage now exists, with broader post lifecycle coverage still present in community flows. |
| `/public-posts/:postId` | `src/routes/public-posts.ts` | `tests/routes/communities/community-routes.test.ts`, `tests/routes/communities/public-communities-routes.test.ts`, `tests/routes/jobs-posts-routes.test.ts` | direct/indirect | Public visibility behavior is exercised from community/post flows. |
| `/public-communities/*` | `src/routes/public-communities.ts` | `tests/routes/communities/public-communities-routes.test.ts` | direct | Covers public community reads/listings/posts. |
| `/public-names/*` | `src/routes/public-names.ts` | `tests/routes/public-names/public-names-routes.test.ts` | direct | Covers public Pirate-name resolution and status responses. |
| `/public-namespaces/*` | `src/routes/public-namespaces.ts` | `tests/routes/public-namespaces-routes.test.ts` | direct | Resolves verified, unexpired, Pirate-routed HNS namespaces for gateway and Freedom clients. |
| `/profiles/*` | `src/routes/profiles.ts` | `tests/routes/profiles/profiles-routes.test.ts` | direct | Includes patch, read, rename, upgrade quote, linked handles, primary handle. |
| `/bookings/*` | `src/routes/bookings.ts` | `tests/routes/bookings-routes.test.ts`, `src/lib/bookings/*\.pg.test.ts`, `src/lib/bookings/host-config-repository.production-path.pg.test.ts` | direct/service/PG | Global booking API surface. Route suite covers auth, parameter/body normalization, aliases, status mapping, and service wiring; real-Postgres service tests cover durable behavior. |
| `/host-bookings/me/*` | `src/routes/host-bookings.ts` | `tests/routes/host-bookings-routes.test.ts` | direct | Covers host profile upsert, publish/unpublish, availability rules / exceptions / price rules CRUD, hard bounds, FK precondition, and envelope shape. |
| `/public-profiles/:handleLabel` | `src/routes/public-profiles.ts` | `tests/routes/profiles/profiles-routes.test.ts`, `tests/routes/profiles/public-profiles-routes.test.ts` | direct | Covered alongside profile/global-handle tests. |
| `/wallet-identities/:chainRef/:walletAddress` | `src/routes/wallet-identities.ts` | `tests/routes/wallet-identities-routes.test.ts` | direct | Covers wallet-owned Pirate-name identity projection, profile redirect for attached wallets, 404 for unknown wallets, and chain/address validation errors. |
| `/profile-media/*` | `src/routes/profile-media.ts` | `tests/routes/profiles/profile-media-routes.test.ts` | direct | Upload and fetch covered. |
| `/community-media/*` | `src/routes/community-media.ts` | `tests/routes/communities/community-media-routes.test.ts` | direct | Upload and fetch covered. |
| `/health` | `src/index.ts` | `tests/routes/health-routes.test.ts` | direct | Dedicated health route coverage exists. |
| non-production `/__debug/sentry-error` | `src/index.ts` | none | smoke-only | Intentional manual Sentry smoke endpoint; production returns 404. |
| `/mcp/*` | `src/routes/mcp.ts` | `tests/routes/mcp-routes.test.ts` | direct | Covers server metadata, tool listing, community discovery, public reads, and write-tool guardrails. |

## Weak Spots

- `routes/communities.ts` has been split, but community behavior is still tested through several large suites, which makes coverage easy to overestimate.
- Story/CDR-related commerce behavior is exercised from route tests with deterministic test doubles. Keep [STORY_CDR_PATHS.md](STORY_CDR_PATHS.md) current as the live path map.

## Priority Follow-Up

1. Keep splitting large community and song-artifact suites where a route group can stand on its own.
2. Add live-infrastructure Story/CDR validation when a stable test environment exists.
3. Keep `STORY_CDR_PATHS.md` updated when a new Story/CDR entry point is added.
