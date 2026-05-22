# Story/CDR Path Map

## Purpose

This documents which Story/CDR code paths are live, how they are reached, and where coverage exists.

Story/CDR is active commerce infrastructure. It should not be treated as dead code simply because most modules are reached through community commerce rather than imported directly by top-level routes.

## Live Entry Points

| User-facing path | Route module | Service path | Story/CDR modules | Current coverage |
| --- | --- | --- | --- | --- |
| `POST /communities/{community_id}/song-artifacts` for locked song bundles | `services/api/src/routes/communities-song-artifacts.ts` | `createSongArtifactBundle` -> `createSongAssetForPost` -> locked delivery preparation | `story-cdr.ts`, `story-publish-service.ts`, `story-royalty-registration-service.ts`, `story-runtime-funding.ts`, `story-identifiers.ts` | `tests/routes/song-artifacts/song-artifact-locked-routes.test.ts`, `tests/routes/song-artifacts/song-artifact-donation-routes.test.ts`, `tests/routes/song-artifacts/song-artifact-local-fallback-routes.test.ts` |
| `GET /communities/{community_id}/assets/{asset_id}/access` | `services/api/src/routes/communities-commerce.ts` | `resolveCommunityAssetAccess` -> `buildStoryCdrAccessPackage` | `story-access-proof-service.ts`, `story-runtime-config.ts`, `story-identifiers.ts` | `tests/routes/song-artifacts/song-artifact-locked-routes.test.ts` |
| `GET /communities/{community_id}/assets/{asset_id}/content` | `services/api/src/routes/communities-commerce.ts` | `fetchCommunityAssetContent` | locked delivery metadata produced by Story/CDR preparation | `tests/routes/song-artifacts/song-artifact-locked-routes.test.ts` |
| `POST /communities/{community_id}/listings` and listing updates | `services/api/src/routes/communities-commerce.ts` | `createCommunityListing` / `updateCommunityListing` -> `assertAssetReadyForStoryRoyaltyCommerce` | Story readiness is enforced through asset Story fields | `tests/routes/song-artifacts/song-artifact-locked-routes.test.ts`, `tests/routes/song-artifacts/song-artifact-donation-routes.test.ts` |
| `POST /communities/{community_id}/purchase-quotes` | `services/api/src/routes/communities-commerce.ts` | `createCommunityPurchaseQuote` -> settlement mode and signer checks | `story-direct-signer.ts`, Story readiness helpers | `tests/routes/song-artifacts/song-artifact-locked-routes.test.ts`, `tests/routes/song-artifacts/song-artifact-donation-routes.test.ts` |
| `POST /communities/{community_id}/purchase-settlements` | `services/api/src/routes/communities-commerce.ts` | `settleCommunityPurchase` | `story-royalty-settlement-service.ts`, `story-identifiers.ts`, settlement effects | `tests/routes/song-artifacts/song-artifact-locked-routes.test.ts`, `tests/routes/song-artifacts/song-artifact-donation-routes.test.ts` |
| local/runtime maintenance scripts | `services/api/scripts/*.ts` | runtime signer funding/cancel helpers | `story-runtime-funding.ts`, `story-direct-signer.ts` | script-level coverage is limited |

## Local Fallbacks

Locked delivery has an intentional local fallback in `createSongAssetForPost` when Story runtime keys are missing in a local environment. The fallback returns synthetic Story/CDR metadata so local song-commerce flows can be exercised without live Story infrastructure.

This fallback is only appropriate for local development and route tests. Production-like environments should configure the Story operator, CDR writer, settlement, access signer, and runtime funding settings instead of relying on fallback behavior.

## Test Doubles

The main Story/CDR route tests install explicit test doubles through:

- `setStoryCdrUploaderForTests`
- `setStoryAssetPublisherForTests`
- `setStoryAccessProofSignerForTests`
- `setStoryRoyaltyRegistrarForTests`
- `setStoryRoyaltyPurchaseSettlementExecutorForTests`
- `setStoryRoyaltyEntitlementMinterForTests`
- `setStoryParentRoyaltyVaultTransferExecutorForTests`
- `setStoryRuntimeFundingAssertionForTests`

These doubles make route tests deterministic while preserving the service call graph. They do not prove live chain integration.

## Remaining Gaps

- No standalone integration test proves live Story RPC, CDR upload, and royalty settlement against real infrastructure.
- Runtime maintenance scripts have limited automated coverage.
- The route coverage map should stay updated when a new Story/CDR entry point is added.
