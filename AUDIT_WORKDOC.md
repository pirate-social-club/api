# Pirate API Audit Workdoc

## Purpose

This document turns the current `pirate-api` review into concrete work items that another AI can verify independently.

Scope:

- repo organization
- dead code and dead stories
- naming and boundaries
- DRY problems
- testing posture
- CI/source-of-truth gaps

Repo root:

- `/home/t42/Documents/pirate-workspace/api`

## Current Assessment

Status: mixed

- The repo has real structure and a usable test harness.
- The worst route/module boundary issues have been reduced materially.
- Static hygiene and route coverage visibility are much better than at the start of the audit.
- The remaining risks are concentrated in cross-repo contracts freshness, full API suite trust, and explicit Story/CDR coverage or gating.
- Generated contracts still have a source-of-truth gap across repo boundaries.

## Status Snapshot

- Completed: Task 3, Task 5, Task 6, Task 7, Task 8, Task 9
- Partially complete: Task 1, Task 2
- Open: Task 4

Recent related commits:

- `2866fc5` Rename control plane repositories by role
- `1fb4204` Extract shared media storage helpers
- `8aa82a5` Refresh API README for current surface
- `654325e` Seed local story PKP defaults
- `4f25d68` Generalize control plane DB client
- `1d2ce00` Extract shared community route helpers
- `b22982a` Split community routes by domain
- `3fa21f8` Checkpoint audit fixes and story commerce work

## Audit Instructions For Another AI

Use this order:

1. Read this file.
2. Read `README.md`.
3. Read `api/services/api/README.md`.
4. Read `pirate-api/.github/workflows/api-ci.yml`.
5. Inspect `services/api/src/index.ts` and `services/api/src/routes/*.ts`.
6. Inspect large files under `services/api/src/lib/`.
7. Run the smallest relevant checks first.

Suggested commands:

```bash
cd /home/t42/Documents/pirate-workspace/api
rtk git status --short
rtk rg --files services/api/src services/api/tests services/cli/src services/contracts/src
rtk bun run test
```

Repo-native checks:

```bash
cd /home/t42/Documents/pirate-workspace/api/services/cli
rtk bun run test

cd /home/t42/Documents/pirate-workspace/api/services/api
rtk bun run test
```

When auditing, record:

- whether each task below is still valid
- whether the cited evidence still exists
- whether the risk level changed
- whether the task is complete, partially complete, or not started

## Tasks

### Task 1: Fix Contracts Source-Of-Truth Drift

Priority: high
Status: partially complete

Problem:

- `services/contracts` is generated from material outside this repo.
- CI does not appear to watch or regenerate that external source.
- CI typechecks generated output without regenerating it first.
- A spec change can leave generated contracts completely stale while CI still passes.

Evidence:

- `services/contracts/package.json:11`
- `.github/workflows/api-ci.yml:3`
- `.github/workflows/api-ci.yml:21`

Audit questions:

- Does the contracts generator still read from `../../../specs/api/...`?
- Does CI now watch `specs/api/**` or otherwise validate generated output freshness?
- Does CI regenerate contracts before typecheck/tests, or fail if generated output is stale?

Definition of done:

- There is one explicit source of truth for generated contracts.
- CI verifies freshness, not just typechecks the generated package.
- A stale generated contract file is detectable in automation.

Suggested fixes:

- Add a freshness check step that regenerates and fails on diff.
- Expand workflow triggers to include the upstream specs path if it remains the source of truth.
- Document the ownership boundary between `specs/api` and `services/contracts`.

Progress:

- Added a local freshness check in `services/contracts`.
- Documented the repo-boundary limitation in `CONTRACTS_BOUNDARY.md`.
- This is not fully complete because `pirate-api` CI still cannot prove freshness from sibling `specs/api` inputs on its own.

### Task 2: Stabilize The API Test Suite

Priority: high
Status: partially complete

Problem:

- `services/api` tests currently show timeouts and cascading missing-table failures.
- This makes the suite unreliable as a regression signal.

Evidence:

- `services/api/tests/helpers.ts:89`
- `services/api/tests/routes/song-artifacts/song-artifact-routes.test.ts`
- `services/api/tests/routes/verification/verification-routes.test.ts`

Observed symptoms during review:

- timeouts in profile and song-artifact tests
- later failures referencing missing tables like `verification_sessions`, `users`, and `auth_provider_links`
- unhandled errors between tests causing unrelated later failures

Audit questions:

- Does `rtk bun run test` in `services/api` pass consistently from a clean run?
- If it passes, does it pass twice in a row?
- Are failures still cascading from shared global state or leaked runtime caches?
- Is cleanup in `tests/helpers.ts` sufficient for all test paths?

Definition of done:

- `services/api` test suite passes consistently from a clean checkout.
- Re-running the suite does not produce order-dependent failures.
- Shared caches, DB state, and temp resources are reset deterministically.

Suggested fixes:

- Audit global singletons and cached providers.
- Reduce cross-test shared state.
- Isolate the heaviest integration flows from the broad route suite if needed.
- Raise timeouts only after isolation is correct.

Progress:

- Multiple focused route and repository suites were added or strengthened and pass locally.
- Targeted verification runs are green, including community, profile, media, jobs/posts, and repository coverage.
- This is still not fully complete because the audit goal was trust in clean repeated full-suite runs, and that has not yet been proven for all of `services/api`.

### Task 3: Break Up The Communities God Route

Priority: high
Status: complete

Problem:

- `routes/communities.ts` owns too many capabilities.
- It currently acts as the integration point for community creation, policy, membership, listings, purchases, assets, posts, and song artifacts.

Evidence:

- `services/api/src/routes/communities.ts:1`
- `services/api/src/routes/communities.ts:77`
- `services/api/src/routes/communities.ts:118`
- `services/api/src/routes/communities.ts:342`
- `services/api/src/routes/communities.ts:488`

Audit questions:

- Is `routes/communities.ts` still the largest or most overloaded route file?
- Have subrouters been split by capability?
- Is there now a clear ownership map for communities, commerce, and artifacts?

Definition of done:

- `communities` routing is split into smaller modules with clear capability boundaries.
- A contributor can locate feature ownership without reading one giant route file.
- Route-level auth exceptions and special cases are localized instead of hidden in one broad router.

Suggested target split:

- Start with a proportional split:
- `routes/communities/core.ts`
- `routes/communities/commerce.ts`
- `routes/communities/song-artifacts.ts`
- Further subdivision should happen only if the resulting files stay overloaded after the first pass.

Completed work:

- `routes/communities.ts` was reduced to a mount/auth shell.
- Capability-specific routing was split into `communities-core.ts`, `communities-commerce.ts`, and `communities-song-artifacts.ts`.
- Shared route wiring was further reduced with `communities-route-helpers.ts`.

### Task 4: Prove Story/CDR Coverage Or Gate It Explicitly

Priority: medium-high
Status: open

Problem:

- Story-related modules are wired indirectly through the commerce path rather than imported directly from routes.
- That makes the subsystem easy to miss during audit and easy to misclassify.
- The main risk is active under-development code with unclear execution paths, weak documentation, and uncertain test coverage.

Evidence:

- `services/api/src/routes/communities.ts:38`
- `services/api/src/lib/communities/community-commerce-service.ts:1`
- `services/api/src/lib/story/story-publish-service.ts:35`
- `services/api/src/lib/story/story-settlement-service.ts:22`
- `services/api/src/lib/story/story-access-proof-service.ts:53`
- `services/api/src/lib/story/story-cdr.ts:1`

Audit questions:

- Which Story/CDR code paths are actually reachable from live route/service flows?
- Are there tests that exercise the Story path end to end?
- Is the feature live, gated, or actively in development behind partial plumbing?
- If coverage is partial, which exact Story/CDR paths are intentionally incomplete?

Definition of done:

- Each Story module is either:
  - wired into a tested live path, or
  - explicitly feature-flagged and documented, or
  - removed from the main service tree

Suggested fixes:

- Document the actual import chain from routes into commerce and Story/CDR helpers.
- Add focused tests that prove the intended Story/CDR paths are exercised, or document which ones are deferred.
- If some paths are development-only, gate them explicitly and say so in docs.

Current note:

- Story/CDR is active development, not dead code.
- Some commerce-adjacent route coverage exists, but the exact tested Story/CDR path map is still not documented precisely enough to close this task.

### Task 5: Eliminate Media Upload DRY Debt

Priority: medium
Status: complete

Problem:

- Profile and community media paths are near-duplicate implementations.
- This duplication exists both at the route layer and the service layer.

Evidence:

- `services/api/src/routes/profile-media.ts:13`
- `services/api/src/routes/community-media.ts:13`
- `services/api/src/lib/auth/profile-media-service.ts:1`
- `services/api/src/lib/communities/community-media-service.ts:1`

Audit questions:

- Are these still duplicated line-for-line or nearly so?
- Has shared Filebase signing logic been extracted?
- Are media validation rules centralized?

Definition of done:

- Shared media upload/download mechanics live in one reusable module.
- Domain-specific differences are limited to kind definitions, object-key prefixes, and policy.
- Future fixes to signing/storage behavior happen in one place.

Suggested extraction boundary:

- shared storage signing
- shared MIME and size validation helpers
- shared object fetch path
- thin domain wrappers for profile/community specifics

Completed work:

- Shared storage behavior now lives in `services/api/src/lib/media-storage.ts`.
- Shared multipart/media route logic now lives in `services/api/src/routes/media-route-helpers.ts`.
- Profile/community media routes and services were reduced to thinner domain wrappers.

### Task 6: Rename Modules Around Domain Ownership

Priority: medium
Status: complete

Problem:

- Some module names describe storage provenance or implementation history rather than business capability.
- The `auth/` tree currently contains profile, identity, linked-handle, and projection concerns.

Evidence:

- `services/api/src/lib/auth/control-plane-auth-queries.ts:1`
- `services/api/src/lib/auth/control-plane-auth-rows.ts:1`
- `services/api/src/lib/auth/control-plane-profile-repository.ts:1`
- `services/api/src/lib/auth/control-plane-identity-repository.ts:1`

Audit questions:

- Do file names now reflect what the module owns?
- Are profile and identity concerns still nested under `auth/` mainly because of history?
- Can a new contributor predict file ownership from names alone?

Definition of done:

- File and directory names reflect domain capability first.
- Persistence implementation details are secondary.
- Profiles, identity, auth, and handles are separated cleanly enough to navigate.

Suggested direction:

- separate `auth`, `identity`, `profiles`, and `handles`
- keep implementation-specific names inside lower-level files, not top-level domain boundaries

Completed work:

- `control-plane-*` repository/module naming was replaced with role-based names such as `auth-db-*`, `db-identity-repository`, `db-profile-repository`, and `db-community-repository`.
- Remaining imports and tests were updated to the new names.
- This improved naming materially, though a larger future directory split between `auth`, `identity`, `profiles`, and `handles` may still be worthwhile.

### Task 7: Update The Repo Story In Docs

Priority: medium
Status: complete

Problem:

- The docs still describe an earlier, smaller “first slice” narrative.
- The actual route surface is much larger than what the main API README says.
- The README currently lists roughly the early route set and omits major live areas now present in `routes/`.

Evidence:

- `services/api/README.md:3`
- `services/api/README.md:7`
- `services/api/src/index.ts:1`
- `services/api/src/routes/communities.ts:77`

Audit questions:

- Does the README now match the actual route surface?
- Does it explain which areas are stable, in progress, or experimental?
- Does it describe current package ownership and test expectations?
- Does it clearly distinguish active features from dead or experimental code?

Definition of done:

- The README reflects current capabilities honestly.
- Experimental or partial areas are labeled clearly.
- Another AI or engineer can read the docs and not build the wrong mental model.

Completed work:

- `services/api/README.md` was refreshed to match the current route surface, module layout, config names, and community-router split.

### Task 8: Tighten Static Hygiene And Test Typechecking

Priority: medium
Status: complete

Problem:

- TypeScript is strict, but the config does not currently push hard on unused locals/params.
- CLI tests are excluded from the CLI TypeScript project.
- Both API and CLI configs are missing `noUnusedLocals` and `noUnusedParameters`.
- Excluding CLI tests hides type errors in test code.

Evidence:

- `services/api/tsconfig.json:2`
- `services/cli/tsconfig.json:11`

Audit questions:

- Are `noUnusedLocals` and `noUnusedParameters` enabled now?
- Are test files typechecked where appropriate?
- Is there a lint or static pass for dead exports if the project wants that?

Definition of done:

- The repo catches more dead-code drift automatically.
- Test files are included or intentionally handled with a documented reason.
- Static checks support cleanup instead of relying only on manual review.

Completed work:

- `noUnusedLocals` and `noUnusedParameters` are enabled in API, CLI, and contracts TypeScript configs.
- CLI tests are now typechecked.
- The API unused-symbol pass was completed and verified with `tsc --noEmit`.

### Task 9: Inventory Route Coverage Gaps

Priority: medium
Status: complete

Problem:

- Task 2 stabilizes the suite, but does not answer whether the live route surface is adequately covered.
- A stable green suite is still weak if large parts of the active API are untested.

Evidence:

- `services/api/src/index.ts:1`
- `services/api/src/routes/*.ts`
- `services/api/tests/*.test.ts`

Audit questions:

- Which live routes have direct route-level coverage today?
- Which major route groups are only covered indirectly?
- Which live routes have no meaningful tests at all?

Definition of done:

- There is a route-to-test inventory for the current API surface.
- Untested or weakly tested route groups are identified explicitly.
- Follow-up test work can be prioritized by risk instead of guesswork.

Suggested output:

- one table mapping route groups to test files
- one short list of uncovered or weakly covered endpoints
- one priority ranking for which gaps matter first

Completed work:

- `ROUTE_COVERAGE.md` now maps the live route surface to primary test files, notes weak spots, and identifies follow-up priorities.

## Suggested Sequencing

Recommended order:

1. Task 1
2. Task 2
3. Task 3
4. Task 5
5. Task 6
6. Task 8
7. Task 7
8. Task 9
9. Task 4

Reasoning:

- CI and test trust come first.
- Then reduce the worst organizational bottlenecks.
- Then clean up duplication and naming.
- Then turn on stronger mechanical hygiene before making deeper subsystem judgments.
- Then inventory route coverage gaps so Story/CDR and other active paths can be assessed against actual tests.
- Then decide how to document, gate, or expand coverage for the actively developed Story/CDR surface.

## Audit Template

Another AI can copy this template and fill it in:

```md
# Pirate API Audit Follow-Up

Date:
Auditor:
Commit:

## Summary

- Overall status:
- Biggest remaining risk:
- Most improved area:

## Task Status

### Task 1: Fix Contracts Source-Of-Truth Drift
- Status:
- Evidence:
- Notes:

### Task 2: Stabilize The API Test Suite
- Status:
- Evidence:
- Notes:

### Task 3: Break Up The Communities God Route
- Status:
- Evidence:
- Notes:

### Task 4: Prove Story/CDR Coverage Or Gate It Explicitly
- Status:
- Evidence:
- Notes:

### Task 5: Eliminate Media Upload DRY Debt
- Status:
- Evidence:
- Notes:

### Task 6: Rename Modules Around Domain Ownership
- Status:
- Evidence:
- Notes:

### Task 7: Update The Repo Story In Docs
- Status:
- Evidence:
- Notes:

### Task 8: Tighten Static Hygiene And Test Typechecking
- Status:
- Evidence:
- Notes:

### Task 9: Inventory Route Coverage Gaps
- Status:
- Evidence:
- Notes:
```
