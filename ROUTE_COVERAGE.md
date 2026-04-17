# API Route Coverage

## Purpose

This is the current route-to-test inventory for `services/api`.

It is not a claim that the suite is stable.
It only maps the live route surface to where direct route-level coverage appears to exist today.

## Route Surface

Mounted in `services/api/src/index.ts`:

- `/auth`
- `/community-media`
- `/communities`
- `/jobs`
- `/posts`
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
| `/auth/session/exchange` | `src/routes/auth.ts` | `tests/auth-routes.test.ts` | direct | Also exercised by many other route suites for setup. |
| `/users/me` | `src/routes/users.ts` | `tests/auth-routes.test.ts` | direct | Covered via auth flow tests. |
| `/onboarding/*` | `src/routes/onboarding.ts` | `tests/onboarding-routes.test.ts`, `tests/auth-routes.test.ts` | direct | Includes status, reddit verification, reddit imports. |
| verification routes under `/` | `src/routes/verification.ts` | `tests/verification-routes.test.ts` | direct | Heavy route coverage, but suite stability is currently weak. |
| `/communities` core and membership paths | `src/routes/communities.ts` | `tests/community-routes.test.ts` | direct | Large surface covered here, including create, get, gates, rules, join, preview, join eligibility. |
| `/communities/*/song-artifact-*` and commerce-adjacent flows | `src/routes/communities.ts` | `tests/song-artifact-routes.test.ts` | direct | Covers song uploads, bundles, assets, listings, purchase quotes, settlements, and Story/CDR-adjacent commerce paths. |
| `/jobs/:jobId` | `src/routes/jobs.ts` | `tests/jobs-posts-routes.test.ts`, `tests/community-routes.test.ts` | direct | Dedicated jobs coverage now exists, with broader assertions still present in community flows. |
| `/posts/:postId` and `/posts/:postId/vote` | `src/routes/posts.ts` | `tests/jobs-posts-routes.test.ts`, `tests/community-routes.test.ts` | direct | Dedicated post read/vote coverage now exists, with broader post lifecycle coverage still present in community flows. |
| `/profiles/*` | `src/routes/profiles.ts` | `tests/profiles-routes.test.ts` | direct | Includes patch, read, rename, upgrade quote, linked handles, primary handle. |
| `/public-profiles/:handleLabel` | `src/routes/public-profiles.ts` | `tests/profiles-routes.test.ts` | direct | Covered alongside profile/global-handle tests. |
| `/profile-media/*` | `src/routes/profile-media.ts` | `tests/profile-media-routes.test.ts` | direct | Upload and fetch covered. |
| `/community-media/*` | `src/routes/community-media.ts` | `tests/community-media-routes.test.ts` | direct | Upload and fetch covered. |
| `/health` | `src/index.ts` | `tests/health-routes.test.ts` | direct | Dedicated health route coverage exists. |

## Weak Spots

- `routes/communities.ts` is tested through two large suites, but its breadth makes coverage easy to overestimate.
- Story/CDR-related commerce behavior is exercised from `song-artifact-routes.test.ts`, but this area needs a more explicit proof of which Story/CDR paths are truly covered versus merely reachable.

## Priority Follow-Up

1. Stabilize `tests/community-routes.test.ts`, `tests/song-artifact-routes.test.ts`, and `tests/verification-routes.test.ts` before trusting the map above.
2. Split the `communities` route surface and then remap coverage by subrouter instead of one giant file.
3. Add an explicit Story/CDR coverage note once the intended code paths are pinned down.
