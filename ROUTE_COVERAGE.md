# API Route Coverage

## Purpose

This is the current route-to-test inventory for `services/api`.

It is not a claim that the suite is stable.
It only maps the live route surface to where direct route-level coverage appears to exist today.

## Route Surface

Mounted in `services/api/src/index.ts`:

- `/auth`
- `/` for discovery routes
- `/` for agent routes
- `/community-media`
- `/comments`
- `/communities`
- `/feed`
- `/jobs`
- `/notifications`
- `/posts`
- `/public-agents`
- `/public-comments`
- `/public-communities`
- `/public-posts`
- `/public-profiles`
- `/profile-media`
- `/users`
- `/onboarding`
- `/profiles`
- `/` for verification routes
- `/health`

## Coverage Map

| Route Group | Main Route File | Primary Test Files | Coverage Status | Notes |
| --- | --- | --- | --- | --- |
| discovery routes under `/` | `src/routes/discovery.ts` | `tests/discovery-routes.test.ts` | direct | Covers well-known discovery responses. |
| `/auth/session/exchange` | `src/routes/auth.ts` | `tests/auth-routes.test.ts` | direct | Also exercised by many other route suites for setup. |
| `/users/me` | `src/routes/users.ts` | `tests/auth-routes.test.ts` | direct | Covered via auth flow tests. |
| `/onboarding/*` | `src/routes/onboarding.ts` | `tests/onboarding-routes.test.ts`, `tests/auth-routes.test.ts` | direct | Includes status, reddit verification, reddit imports. |
| verification routes under `/` | `src/routes/verification.ts` | `tests/verification-routes.test.ts` | direct | Heavy route coverage, but suite stability is currently weak. |
| `/agents/*` | `src/routes/agents.ts` | `tests/agents-routes.test.ts`, `tests/agent-action-proof.test.ts` | direct | Covers ownership, handles, credentials, connection tokens, and action proof helpers. |
| `/public-agents/:handleLabel` | `src/routes/public-agents.ts` | `tests/agents-routes.test.ts` | direct | Covered alongside agent handle flows. |
| `/communities` core and membership paths | `src/routes/communities.ts`, `src/routes/communities-core.ts` | `tests/community-routes.test.ts`, `tests/community-membership-routes.test.ts`, `tests/community-settings-routes.test.ts`, `tests/community-post-routes.test.ts`, moderation and gates suites | direct | Split route files exist, but broad behavior is still distributed across several large suites. |
| `/communities/*` commerce paths | `src/routes/communities-commerce.ts` | `tests/song-artifact-routes.test.ts`, `tests/song-artifact-locked-routes.test.ts`, `tests/community-commerce-*.test.ts` | direct/partial | Asset/listing/purchase coverage exists; Story/CDR path coverage still needs an explicit map. |
| `/communities/*/song-artifact-*` | `src/routes/communities-song-artifacts.ts` | `tests/song-artifact-routes.test.ts`, `tests/song-artifact-catalog-*.test.ts`, `tests/song-artifact-locked-routes.test.ts` | direct | Covers song uploads, bundles, locked assets, catalog sync, and local fallback paths. |
| `/comments/*` | `src/routes/comments.ts` | `tests/comments-routes.test.ts`, `tests/comments-read-routes.test.ts`, `tests/comment-service*.test.ts` | direct | Covers create/read/replies/context/vote/delete through route and service tests. |
| `/public-comments/*` | `src/routes/public-comments.ts` | `tests/comments-read-routes.test.ts` | direct | Covers public post comments and public replies. |
| `/feed/home` | `src/routes/feed.ts` | `src/lib/feed/home-feed-service.test.ts`, broader public-post tests | indirect | Service coverage exists; route-level coverage should be added. |
| `/jobs/:jobId` | `src/routes/jobs.ts` | `tests/jobs-posts-routes.test.ts`, `tests/community-routes.test.ts` | direct | Dedicated jobs coverage now exists, with broader assertions still present in community flows. |
| `/notifications/*` | `src/routes/notifications.ts` | none located | gap | Add direct route coverage for summary, tasks, feed, mark-read, and dismiss-task. |
| `/posts/:postId` and `/posts/:postId/vote` | `src/routes/posts.ts` | `tests/jobs-posts-routes.test.ts`, `tests/community-routes.test.ts` | direct | Dedicated post read/vote coverage now exists, with broader post lifecycle coverage still present in community flows. |
| `/public-posts/:postId` | `src/routes/public-posts.ts` | `tests/community-routes.test.ts`, `tests/public-communities-routes.test.ts`, `tests/jobs-posts-routes.test.ts` | direct/indirect | Public visibility behavior is exercised from community/post flows. |
| `/public-communities/*` | `src/routes/public-communities.ts` | `tests/public-communities-routes.test.ts` | direct | Covers public community reads/listings/posts. |
| `/profiles/*` | `src/routes/profiles.ts` | `tests/profiles-routes.test.ts` | direct | Includes patch, read, rename, upgrade quote, linked handles, primary handle. |
| `/public-profiles/:handleLabel` | `src/routes/public-profiles.ts` | `tests/profiles-routes.test.ts`, `tests/public-profiles-routes.test.ts` | direct | Covered alongside profile/global-handle tests. |
| `/profile-media/*` | `src/routes/profile-media.ts` | `tests/profile-media-routes.test.ts` | direct | Upload and fetch covered. |
| `/community-media/*` | `src/routes/community-media.ts` | `tests/community-media-routes.test.ts` | direct | Upload and fetch covered. |
| `/health` | `src/index.ts` | `tests/health-routes.test.ts` | direct | Dedicated health route coverage exists. |

## Weak Spots

- `routes/communities.ts` has been split, but community behavior is still tested through several large suites, which makes coverage easy to overestimate.
- `/notifications/*` appears to lack direct route-level coverage.
- `/feed/home` has service coverage, but route-level coverage should be added.
- Story/CDR-related commerce behavior is exercised from `song-artifact-routes.test.ts`, but this area needs a more explicit proof of which Story/CDR paths are truly covered versus merely reachable.

## Priority Follow-Up

1. Add direct route coverage for `/notifications/*` and `/feed/home`.
2. Add an explicit Story/CDR coverage note once the intended code paths are pinned down.
3. Keep splitting large community and song-artifact suites where a route group can stand on its own.
