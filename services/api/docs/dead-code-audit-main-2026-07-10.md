# API dead-code audit on current main — 2026-07-10

Baseline: `origin/main` at `f3592eba` plus the Knip entrypoint/virtual-module configuration commit on this branch. Counts re-verified after rebasing past `#310` (reward qualification evidence), which added no unused exports.

## Verified baseline

- `bunx tsc --noEmit`: passes.
- Default `knip`: 112 unused value exports and 205 unused exported types.
- Compact Knip reports 84/81 because that reporter counts affected files, not symbols.
- `knip --dependencies`: no unused or unlisted dependencies.
- `knip --production --dependencies` lists all 20 runtime dependencies as unused, so that mode is not actionable for this Worker entry graph. In particular, `@libsql/client` is still imported by production-reachable local-community modules and must remain a runtime dependency unless those imports are isolated first.
- Community-scoped bookings remain mounted from `src/routes/communities.ts`; their findings require a product/architecture decision.

Classification is based on Knip JSON, declaration occurrence within the defining module, barrel-export syntax, and cross-repository searches in API contracts, Web, and Core. “Safe” still means apply the change and run the focused test listed below; it does not mean bulk-delete without compilation.

## Summary

| Classification | Values | Types | Recommended action |
| --- | ---: | ---: | --- |
| Safe to unexport | 73 | 131 | Remove `export`; retain implementation. |
| Safe delete candidate | 23 | 11 | Delete the declaration or obsolete re-export after focused verification. |
| Redundant barrel export | 8 | 14 | Remove only the facade export; retain the canonical export. |
| Test seam review | 3 | 0 | Confirm no dynamic mocking, then replace/remove module-global seam. |
| Community-bookings product decision | 5 | 9 | Do not change as dead code while routes remain mounted. |
| Cross-repo contract review | 0 | 40 | Preserve canonical contracts; remove API-local re-exports only after consumer checks. |
| **Total** | **112** | **205** | |

## Safe to unexport

These symbols have internal references in their defining modules but no project consumer of the export.

- `src/lib/agent-discovery/structured-links.ts` — `StructuredAccessLink`.
- `src/lib/agents/agent-ownership-repository.ts` — `AgentOwnershipRepository`.
- `src/lib/agents/agent-ownership-state-machine.ts` — `AGENT_OWNERSHIP_SESSION_STATUS_MACHINE`, `AGENT_OWNERSHIP_RECORD_STATE_MACHINE`, `USER_AGENT_STATUS_MACHINE`.
- `src/lib/agents/clawkey-provider.ts` — `ClawkeyStartRegistrationResult`, `ClawkeyRegistrationStatusResult`.
- `src/lib/agents/types.ts` — `SelfAgentOwnershipLaunch`, `ClawkeyRegistrationLaunch`.
- `src/lib/analytics/events.ts` — `AnalyticsSource`, `AnalyticsAppSurface`.
- `src/lib/audit.ts` — `AuditActorType`.
- `src/lib/auth-middleware.ts` — `authenticateAgentDelegatedToken`.
- `src/lib/auth/auth-db-onboarding-queries.ts` — `getLatestRedditVerificationSessionRow`.
- `src/lib/auth/auth-serializers.ts` — `serializeLinkedHandleRow`, `serializePirateLinkedHandle`.
- `src/lib/auth/dev/memory-auth-store.ts` — `exposeMemoryUser`, `MemoryLinkedHandle`, `MemoryProfile`.
- `src/lib/auth/ens-linked-handle-service.ts` — `EnsProfileMetadata`.
- `src/lib/bookings/booking-confirm-service.ts` — `BookingPaymentExpectation`, `BookingPaymentVerification`, `PaymentInstructions`, `BookingSnapshot`.
- `src/lib/bookings/booking-custody-adapter.ts` — `GlobalBookingSettlementCoordinator`.
- `src/lib/bookings/booking-finalization-repository.ts` — `FinalizeBookingInput`, `FinalizeBookingResult`.
- `src/lib/bookings/booking-hold-service.ts` — `ResolvedBookingSlot`, `GlobalBookingHoldResponse`.
- `src/lib/bookings/booking-lifecycle-repository.ts` — `ReserveBookingSettlementIntentInput`, `FlagBookingSettlementDisputedInput`, `MarkBookingSettlementAmbiguousInput`, `ResolveBookingSettlementReviewInput`, `FinalizeBookingSettlementInput`, `AttachAttendanceSessionInput`, `HeartbeatAttendanceSessionInput`, `HeartbeatAttendanceSessionResult`.
- `src/lib/bookings/booking-lifecycle-service.ts` — `GlobalBookingOperatorEffect`.
- `src/lib/bookings/booking-read-service.ts` — `BookingSettlementReviewResolution`, `BookingSettlementStatus`.
- `src/lib/bookings/booking-row.ts` — `decodeBookingStatus`.
- `src/lib/bookings/booking-settlement-cron.ts` — `processGlobalBookingSettlements`, `ProcessGlobalBookingSettlementsInput`, `ProcessGlobalBookingSettlementsFn`.
- `src/lib/bookings/booking-settlement-evaluator.ts` — `GlobalBookingSettlementSqlExecutor`.
- `src/lib/bookings/hold-repository.ts` — `CreateHostSlotLockInput`, `CreateBookingHoldInput`, `CreateHoldWithSlotLockInput`, `SlotLockResult`, `CreateHoldWithSlotLockResult`.
- `src/lib/bookings/host-config-repository.ts` — `CreateBookingProfileInput`, `UpdateBookingProfileInput`, `UpsertBookingProfileInput`, `CreateAvailabilityRuleInput`, `UpdateAvailabilityRuleInput`, `CreateAvailabilityExceptionInput`, `UpdateAvailabilityExceptionInput`, `CreatePriceRuleInput`, `UpdatePriceRuleInput`.
- `src/lib/bookings/payment-intent-repository.ts` — `ReservePaymentIntentInput`, `ClaimPaymentIntentInput`, `VerifyPaymentIntentInput`, `CreateOrGetPaymentIntentResult`, `ReservePaymentIntentResult`.
- `src/lib/bookings/settlement-effect-repository.ts` — `BeginSettlementEffectAttemptInput`, `BeginSettlementEffectAttemptResult`, `MirrorSettlementCoordinatorInput`, `MirrorSettlementCoordinatorResult`.
- `src/lib/bookings/types.ts` — `BookingOutcome`.
- `src/lib/communities/assistant-policy/assistant-tools.ts` — `MAX_TOOL_RESULT_CHARS`, `CommunityAssistantToolName`.
- `src/lib/communities/assistant-policy/chat-service.ts` — `CommunityAssistantVoiceMessageSource`, `CommunityAssistantMessageSource`, `CommunityAssistantChat`, `CommunityAssistantMessage`.
- `src/lib/communities/assistant-policy/credential-service.ts` — `getCommunityAssistantCredentialStatus`, `decryptActiveCommunityAssistantCredential`, `getActiveCommunityElevenLabsCredentialPresence`, `CommunityAssistantCredentialProvider`, `ActiveCredentialPresence`.
- `src/lib/communities/assistant-policy/service.ts` — `DEFAULT_OPENROUTER_MODELS`, `AssistantRetentionMode`, `AssistantContextSources`, `AssistantModelOption`, `CommunityAssistantPublicPolicy`.
- `src/lib/communities/board-read/board-read-service.ts` — `BoardReadPostVisibility`.
- `src/lib/communities/commerce/asset-delivery.ts` — `sameStoryAddress`, `encodeStoryAccessAuxData`.
- `src/lib/communities/commerce/royalty-allocation-projection.ts` — `upsertStoryRoyaltyAllocationProjection`.
- `src/lib/communities/commerce/royalty-allocation-verifier.ts` — `createStoryRoyaltyVaultReader`.
- `src/lib/communities/commerce/royalty-allocations.ts` — `SUPPORTED_STORY_ALLOCATION_CHAIN_IDS` (direct declaration; not a barrel despite the mechanical classifier’s initial label).
- `src/lib/communities/commerce/service.ts` — `shouldPrepareLockedDeliveryAsync`.
- `src/lib/communities/commerce/settlement-effects.ts` — `getPurchaseSettlementEffectByIdempotencyKey`, `PurchaseSettlementEffectStatus`.
- `src/lib/communities/commerce/settlement-service.ts` — `RoyaltyEarningEventForNotification`.
- `src/lib/communities/community-binding-resolver.ts` — `ROUTING_CACHE_TTL_MS`, `SHORT_CACHE_TTL_MS`.
- `src/lib/communities/community-machine-access-service.ts` — `omittedSurface`, `getResolvedCommunityMachineAccessPolicy`, `MachineAccessSurface`, `OmittedStructuredSurfaceReason`.
- `src/lib/communities/community-repository-types.ts` — `CommunityRepositoryLifecycle`.
- `src/lib/communities/community-routing-repository.ts` — `toCommunityDatabaseRoutingRow`.
- `src/lib/communities/community-serialization.ts` — `parseStoredCommunityStore`.
- `src/lib/communities/community-token-gates.ts` — `listEthereumMainnetWalletAddresses`.
- `src/lib/communities/community-token-inventory-gates.ts` — `normalizeInventoryMatchValue`, `Erc721InventoryProvider`, `Erc721InventoryAssetCategory`, `Erc721InventoryMatchValue`, `Erc721InventoryAsset`.
- `src/lib/communities/handles/handle-claim-service.ts` — `normalizeCommunityHandleLabel`.
- `src/lib/communities/jobs/post-publish-finalize-handler.ts` — `markPostPublishFinalizeFailed`.
- `src/lib/communities/jobs/runner.ts` — `resolveCommunityJobAttemptTimeoutMs`, `resolveCommunityJobDurableAttemptDeadlineMs`, `resolveCommunityJobStaleCheckpointTimeoutMs`, `createCommunityJobCheckpointRecorder`.
- `src/lib/communities/jobs/store.ts` — `CommunityJobStatus`.
- `src/lib/communities/jobs/video-media-analysis-handler.ts` — `VideoMediaAnalysisJobPayload`.
- `src/lib/communities/live-rooms/access.ts` — `LiveRoomAccessDecisionReason`, `LiveRoomGateFailedSegment`, `LiveRoomGateAccessPayload`.
- `src/lib/communities/live-rooms/recordings.ts` — `LiveRoomRecordingStatus`.
- `src/lib/communities/live-rooms/replay-assets.ts` — `LiveRoomReplayAssetPublicationStatus`.
- `src/lib/communities/live-rooms/runtime.ts` — `liveRoomRuntimeTokenTtlSeconds`, `LiveRoomAudienceSeat`.
- `src/lib/communities/live-rooms/store.ts` — `hydrateLiveRoom`.
- `src/lib/communities/membership/eligibility-service.ts` — `buildWalletScoreStatus`.
- `src/lib/communities/membership/gate-policy-store.ts` — `getGatePolicy`.
- `src/lib/communities/membership/gate-summary.ts` — `buildMembershipGateSummaryFromAtom`.
- `src/lib/communities/membership/gate-types.ts` — `MissingMembershipCapability`.
- `src/lib/communities/provisioning/backend.ts` — `ProvisionedCommunityCredential`, `ProvisionedCommunityDatabase`.
- `src/lib/communities/provisioning/reconciler-host.ts` — `RECONCILER_GRACE_MS`.
- `src/lib/communities/provisioning/reconciler.ts` — `StaleUnloadedPoolBinding`, `ReconcilerOutcome`.
- `src/lib/d1-read-client.ts` — `D1ReadTarget`.
- `src/lib/evm-direct-tx.ts` — `resolveDirectTxFeeOverrides`.
- `src/lib/evm-signer.ts` — `deriveEvmAddressFromPrivateKey`.
- `src/lib/feed/home-feed-community-reader.ts` — `getHomeFeedCommunityIdentity`.
- `src/lib/http/allowed-origins.ts` — `isTrustedHnsWebOrigin`.
- `src/lib/identity/anonymous-identity.ts` — `formatDisclosedQualifierLabel`.
- `src/lib/karaoke/elevenlabs-stt-adapter.ts` — `ELEVENLABS_DEFAULT_STT_WEBSOCKET_URL`, `ELEVENLABS_DEFAULT_STT_MODEL`, `KaraokeSttSocketMessageEvent`.
- `src/lib/karaoke/gateway-token.ts` — `KARAOKE_TOKEN_CLOCK_SKEW_SECONDS`, `KaraokeGatewayTokenErrorCode`.
- `src/lib/karaoke/session-creation-repository.ts` — `KaraokeSessionCreationStatus`.
- `src/lib/karaoke/session-creation-service.ts` — `KARAOKE_SESSION_TTL_SECONDS`, `KaraokeSessionCreateErrorCode`.
- `src/lib/karaoke/session-do.ts` — `SqliteOutboxStore`, `InitializeRequest`, `DurableObjectStorage`, `SqliteOutboxStoreOptions`.
- `src/lib/moderation/moderation-types.ts` — `ModerationCaseStatus`, `ModerationQueueScope`, `UserReportReasonCode`, `ModerationActionType`.
- `src/lib/notifications/notification-emitters.ts` — `emitRoyaltyEarned`.
- `src/lib/observability/submit-trace.ts` — `submitTraceId`.
- `src/lib/openrouter-client.ts` — `OpenRouterModelsResponse`.
- `src/lib/posts/link-enrichment/post-materialization.ts` — `materializeLinkEnrichmentSnapshot`, `enqueueLinkSummaryIfNeeded`, `enqueueLinkSummaryTranslationsIfNeeded`.
- `src/lib/posts/link-enrichment/summary-translation-input.ts` — `emptyStoredLinkSummaryTranslationInput`.
- `src/lib/posts/post-analysis.ts` — `PostAnalysisOutcome`.
- `src/lib/posts/post-create-asset-preparation.ts` — `LOCKED_VIDEO_MAX_BYTES`.
- `src/lib/posts/post-embed-store.ts` — `listPostEmbeds`.
- `src/lib/posts/post-study-generation-provider.ts` — `StudyGenerationSkippedLine`.
- `src/lib/posts/post-study-service.ts` — `upsertStudyEngagementDay`, `materializeStudyStreak`, `StudyAccess`, `SongStudyExercise`, `SongStudySessionSummary`, `SongStudyAttemptProgress`, `SongStreakLeaderboardIdentity`, `SongStreakLeaderboardEntry`, `SongStreakViewerStanding`.
- `src/lib/posts/video-rights-analysis.ts` — `VideoRightsOutcome`, `VideoRightsCaseTrigger`.
- `src/lib/posts/visual-policy-analysis.ts` — `combineVisualPolicyDecisions`, `normalizeVisualClassifierFacts`.
- `src/lib/public-names/public-name-service.ts` — `PublicPirateNamePaymentInstructions`.
- `src/lib/rewards/song-practice-reconciler.ts` — `RewardKind`.
- `src/lib/rights/rights-review-types.ts` — `RightsReviewTriggerSource`, `RightsHoldStatus`.
- `src/lib/song-artifacts/song-artifact-analysis.ts` — `SongAlignmentReason`.
- `src/lib/song-artifacts/song-artifact-repository.ts` — `getSongArtifactUpload`.
- `src/lib/song-artifacts/song-artifact-upload-repository.ts` — `getSongArtifactUpload`.
- `src/lib/song-artifacts/song-artifact-upload-session-repository.ts` — `SongArtifactUploadMode`.
- `src/lib/song-artifacts/song-artifact-upload-session-service.ts` — `SongArtifactMultipartUploadSessionDescriptor`.
- `src/lib/story/story-direct-signer.ts` — `resolveStoryDirectSignerConfig`.
- `src/lib/story/story-runtime-config.ts` — `DEFAULT_STORY_RUNTIME_SIGNER_MIN_BALANCE_WEI`, `DEFAULT_STORY_RUNTIME_SIGNER_TARGET_BALANCE_WEI`.
- `src/lib/story/story-runtime-funding-watchdog.ts` — `STORY_RUNTIME_FUNDING_WATCHDOG_TASK`, `StoryRuntimeFundingWatchdogSignerReport`.
- `src/lib/swarm/swarm-publisher.ts` — `SwarmCollectionFile`.
- `src/lib/telegram/community-chat-service.ts` — `TelegramLinkedChatLinkMode`.
- `src/lib/telegram/telegram-locale.ts` — `RUNTIME_UI_LOCALES`.
- `src/lib/verification/passport-provider.ts` — `PASSPORT_WALLET_SCORE_TTL_MS`.
- `src/lib/verification/self-provider.ts` — `SelfStartResult`, `SelfVerifiedClaims`.
- `src/lib/verification/zkpassport-provider.ts` — `ZkPassportStartResult`.
- `src/lib/wallet-identities/wallet-identity-service.ts` — `WalletIdentityPublicName`.
- `src/routes/cache-headers.ts` — `PUBLIC_READ_CACHE_STALE_SECONDS`.
- `src/routes/communities-karaoke-session-routes.ts` — `handlePublicKaraokePayloadRequest`.

## Safe delete candidates

These names have no second occurrence in their defining module and no API-project consumer. A few are facade entries; in those cases delete only the entry.

- `src/lib/agents/types.ts` — `AgentDelegatedCredentialIssueRequest`, `AgentDelegatedCredentialRefreshRequest`.
- `src/lib/analytics/index.ts` — `analyticsEnvironment`, `upsertCommunityHealthCounts`, `AnalyticsAppSurface`, `AnalyticsEvent`, `AnalyticsSource`, `AnalyticsFlushResult`, `CommunityHealthSyncResult` (remove barrel entries; canonical definitions remain).
- `src/lib/auth/auth-db-community-rows.ts` — `toCommunityDatabaseBindingRow`.
- `src/lib/communities/assistant-policy/assistant-tools.ts` — `clipAssistantToolResult`.
- `src/lib/communities/commerce/asset-delivery.ts` — `prepareLockedSongAssetDelivery`.
- `src/lib/communities/commerce/quote-helpers.ts` — `parseQuoteSettlementAmountAtomic`.
- `src/lib/communities/community-token-gates.ts` — `anyAttachedEthereumWalletOwnsErc721Collection`.
- `src/lib/communities/community-token-inventory-gates.ts` — `Erc721InventoryAssetFilter`.
- `src/lib/communities/live-rooms/agora-cloud-recording.ts` — `isAgoraCloudRecordingConfigured`.
- `src/lib/communities/membership/gate-row.ts` — `toCommunityGateRuleRow`; if its redundant facade export is also removed, the file becomes deletable.
- `src/lib/communities/membership/gate-types.ts` — `CommunityGatePolicyRow`.
- `src/lib/communities/membership/gates.ts` — `satisfiesMembershipGatePolicy`.
- `src/lib/communities/membership/membership-state-store.ts` — `OWNER_ROLE`.
- `src/lib/karaoke/karaoke-attempt-service.ts` — `hasKaraokeAttempt`, `KaraokeTimingTrend`.
- `src/lib/karaoke/snapshot-migrations.ts` — `KARAOKE_SNAPSHOT_MIGRATION_TAG`.
- `src/lib/posts/post-access.ts` — `requireVerifiedHuman` (a different canonical verifier exists under moderation/commerce access paths).
- `src/lib/posts/post-service.ts` — `DeletePostResult` facade entry only.
- `src/lib/song-artifacts/song-artifact-upload-repository.ts` — `createSongArtifactUploadIntent`, `requireSongArtifactUpload`, `markSongArtifactUploadUploaded`; retain the storage-ref lookup used by production.
- `src/lib/song-artifacts/song-artifact-upload-session-repository.ts` — `getSongArtifactUploadSession`.
- `src/lib/story/story-identifiers.ts` — `encodeSignedAccessNamespace`, `encodeSignedAccessCdrConditionData`.
- `src/lib/story/story-royalty-settlement-service.ts` — `settlePurchaseViaStoryRoyalty`.
- `src/lib/story/story-runtime-authorization.ts` — `ensureStorySettlementOperatorAuthorized` and its now-exclusive ABI.
- `src/lib/telegram/community-bot-service.ts` — `decryptActiveCommunityTelegramBot`; retain the nullable variant used by routes.

## Redundant barrel exports

- `src/lib/auth/auth-db-rows.ts` — `toCommunityDatabaseBindingRow`, `DbExecutor`.
- `src/lib/auth/auth-db-user-queries.ts` — `getLatestRedditVerificationSessionRow`.
- `src/lib/communities/commerce/settlement-service.ts` — `PublicCommunityPurchaseSettlement`.
- `src/lib/communities/live-rooms/service.ts` — `LiveRoomAccessMode`, `LiveRoomKind`, `LiveRoomRightsBasis`, `LiveRoomRightsStatus`, `LiveRoomSetlistStatus`, `LiveRoomStatus`, `LiveRoomVisibility`.
- `src/lib/communities/membership/gates.ts` — `toCommunityGateRuleRow`, `GatePolicy`, `GatePolicyEvaluation`.
- `src/lib/feed/home-feed-service.ts` — `HomeFeedCommunityIdentity`, `HomeFeedTimeRange`.
- `src/lib/posts/link-enrichment/repository.ts` — `updateLinkEnrichmentUsageSnapshotSyncedAt`, `upsertLinkEnrichmentUsage`.
- `src/lib/scheduled-cron-lock.ts` — `SCHEDULED_CRON_LOCK_NAME`.
- `src/lib/verification/verification-shared.ts` — `boolToDb`, `SpacesAcceptedSnapshot`.

## Test seams requiring explicit review

These are module-global mutable state in Worker code. Static search found no callers, but confirm no dynamic mocking before removal.

- `src/lib/bookings/booking-custody-adapter.ts` — `setGlobalBookingSettlementCoordinatorForTests`, `setGlobalBookingSettlementConfirmPollPlanForTests`.
- `src/lib/communities/jobs/video-media-analysis-handler.ts` — `setVideoMediaAnalysisProvidersForTests`.

## Community-bookings decision — resolved

Global bookings are the only service and persistence boundary. The
community-scoped routes were already unmounted, and the legacy lifecycle,
settlement, custody, authoring fallback, cron, and tests were deleted in the
dedicated mainlining worktree.

The remaining operator coordinator and chain-configuration modules are shared
by global booking settlement and rewards. They are reachable production code,
not part of the deleted legacy table-set service. Audit their individual
exports normally; do not classify the modules themselves as dead.

## Cross-repo contract boundary: `src/types.ts`

Forty findings are API-local re-exports or component types. Cross-repository search confirms the canonical public definitions live in `services/contracts/src/index.ts`, are generated from Core API specs, and Web imports them from `@pirate/api-contracts` rather than from the private API service package.

Contract re-export candidates: `AuthProof`, `AgentHandleStatus`, `CompleteNamespaceVerificationSessionRequest`, `CompleteVerificationSessionRequest`, `RefreshPassportWalletScoreRequest`, `RefreshPassportWalletScoreResponse`, `CommentVoteResponse`, `CreateRightsReviewActionRequest`, `CreateCommentRequest`, `DismissTaskRequest`, `ErrorResponse`, `MarkNotificationsReadRequest`, `MembershipRequestStatus`, `ModerationAction`, `ModerationCase`, `ModerationCaseDetail`, `ModerationCaseListResponse`, `ModerationSignal`, `MediaAnalysisResult`, `NotificationEvent`, `NotificationReceipt`, `PostPublishFailureCode`, `RightsReviewCase`, `RightsReviewCaseDetail`, `RightsReviewCaseListItem`, `RightsReviewCaseListResponse`, `RoyaltyActivityItem`, `StartNamespaceVerificationSessionRequest`, `StartVerificationSessionRequest`, `UpdateAgentHandleRequest`, `UserReport`.

API-local component types used by larger exported response types and therefore safe to make private, not delete: `CommunityPurchaseSettlementEffectKind`, `CommunityPurchaseSettlementEffectStatus`, `RewardsCashoutSummary`, `LocalizedPostEmbedTranslation`, `PostLabelAssignmentStatus`, `SongPresentation`, `CrosspostSourceStatus`, `CrosspostSource`, `PostEvent`.

Before changing this file, run:

1. API full `tsc --noEmit`.
2. `services/contracts` typecheck/tests.
3. Web safe typecheck or the directly affected Web tests.
4. Core contract generation/check if any canonical contract definition changes. Removing only the private API facade must not modify generated contracts.

## Focused verification matrix

| Area | Narrowest useful verification |
| --- | --- |
| Auth/agents | `tests/routes/auth/auth-routes.test.ts`, `tests/routes/agents/agents-routes.test.ts`, `tests/agent-ownership-state-machine.test.ts` |
| Global bookings | `tests/routes/host-bookings-routes.test.ts`, `tests/lib/booking-attendance-evaluator.test.ts` |
| Removed community bookings boundary | `tests/routes/communities/community-bookings-removed.test.ts` |
| Assistant | Community-assistant route tests and assistant policy/service tests |
| Commerce/Story | Quote-helper, royalty-allocation, settlement buffer, EVM, and Story runtime tests |
| Community routing/gates | Routing repository/resolver, membership gate, and machine-access tests |
| Jobs | Post-publish-finalize unit/integration tests and runner tests |
| Live rooms | Access, runtime, store, recording, and route tests |
| Karaoke | Gateway-token, session creation, session DO, STT adapter, and attempt tests |
| Link enrichment | `src/lib/posts/link-enrichment/service.test.ts` and URL normalization tests |
| Song artifacts | Upload repository/session, analysis, and route tests |
| Verification | Verification-policy and provider tests |
| Central contracts | API full typecheck, contracts checks, Web safe typecheck, Core contract check |

## Recommended PR sequence

1. Barrel-only removals.
2. Safe unexports, grouped by domain.
3. Dead declaration removals, grouped by domain with focused tests.
4. Test-seam/global-state removal.
5. `src/types.ts` facade cleanup with cross-repo checks.
6. Community-bookings decision as a separate breaking-change proposal.

## 2026-08-12 home-feed hydration follow-up

Audit item #8 remains open. The first batching slice reduced query calls inside
each community read, but production endpoint samples did not show a measurable
wall-time improvement: the observed fanout range changed from 2.2–10.8 seconds
to 2.2–11.6 seconds. Do not describe that slice as a latency fix.

The next release is instrumentation-only. Fresh live responses expose:

- Per-request sum and maximum durations for community wall time, database open,
  batched reads, localization, streaks, derivative hydration, and unaccounted
  residual through `Server-Timing`.
- Page-community, prefetch-operation, prefetch-batch, and shard-group
  counts through `x-pirate-home-feed-routing` and the structured timing log.

The aggregate durations are request-local; no module-global counters are used.
Shard counts come from the existing routing pass, not a second resolver scan.
`prefetch_shard_groups` is a sum across prefetch batches. For the mixed
feed's normal single prefetch batch, it is the page's shard-group count.

Before changing the fanout mechanism, collect at least 50 cache-busted mixed
`best` first-page samples on the instrumentation build. Report p50 and p95,
split first/cold observations from subsequent/warm observations, and correlate
the phase metrics with `page_communities` and `prefetch_shard_groups`.

The second hydration slice is accepted only if the same production probe:

1. Reduces p95 `community-fanout` by at least 40% from that instrumentation
   baseline and brings it to at most 5 seconds.
2. Does not regress p50 total `home-feed` time by more than 10%.
3. Produces no repeated `source_post_id` during a seven-page mixed-`best` walk.

If the rewrite uses `bulkCommunityRead`, it must remove both serial waits in
that helper: binding resolution and shard-group reads. Measure the typical
page's shard distribution first; a page spread over many shards would otherwise
replace concurrency-four fanout with serial shard RPCs and can be slower.

### Production baseline and second-slice decision

Release `31637900386` deployed the instrumentation. Fifty sequential,
cache-busted anonymous mixed-`best` first-page requests then produced this
server-side baseline:

| Metric | p50 | p95 |
| --- | ---: | ---: |
| `home-feed` | 12.060s | 14.345s |
| `community-fanout` | 11.177s | 13.126s |
| `community-prefetch` | 1.266s | 1.571s |
| `community-batched-reads-max` | 56ms | 76ms |
| `community-localize-max` | 7.520s | 8.893s |
| `community-derivatives-max` | 2.364s | 2.757s |

All 50 responses reported nine page communities, one prefetch batch, nine
prefetch operations, and one shard group. The first five samples and remaining
45 had the same phase shape, so the latency is not explained by a one-time cold
open. Parallelizing resolver or shard-group loops would optimize the wrong
layer for this page.

The response contained eight song posts and 17 video posts. Code inspection
matched the timing signal: song artifact presentations were fetched from the
control plane sequentially inside the per-post localization loop, with a fresh
request wrapper per post. The approved second slice therefore batches song
artifact bundles and upload proofs per community slice. Keep derivative
hydration as the next measured target after this batch is deployed and the same
50-request probe is repeated.

### Song-artifact batch result and profile-prefetch decision

Release `31645026923` deployed the song-artifact batch. The first production
attempt completed deployment and metadata verification but failed the final HNS
smoke on a transient missing apex redirect; an immediate direct probe passed,
and attempt 2 completed green. The deployed version pair was coherent before
and after the rerun.

The retained 50-request post-change sample was:

| Metric | Before p50/p95 | After p50/p95 | p95 change |
| --- | ---: | ---: | ---: |
| `home-feed` | 12.060s / 14.345s | 11.283s / 13.447s | -6.3% |
| `community-fanout` | 11.177s / 13.126s | 10.455s / 12.474s | -5.0% |
| `community-total-max` | 8.850s / 10.298s | 4.424s / 5.801s | -43.7% |
| `community-localize-max` | 7.520s / 8.893s | 2.501s / 3.753s | -57.8% |
| `community-derivatives-max` | 2.364s / 2.757s | 2.519s / 2.994s | +8.6% |

The batch fixed its direct N+1 but did not satisfy the overall acceptance gate;
audit item #8 remains open. A seven-page mixed-`best` walk returned 174 unique
posts with zero duplicates.

A targeted production Worker trace then showed that derivative local-D1 reads
took only 8–47ms, global derivative projection reads took 382–767ms, and
derivative creator-profile hydration took 0.5–1.76s. Separate author-handle
profile hydration took another 1.27–1.84s in the same community slices, while
control-plane slow logs showed repeated profile-related reads. The next slice
therefore prefetches page-author profiles once into a request-scoped map and
reuses it in both author-handle and derivative enrichment. It exposes
`community-profile-prefetch` timing so the trade remains falsifiable. Do not
increase community concurrency or rewrite shard routing until this profile
duplication is removed and the same production gate is repeated.

Two #8 batching slices have now shipped without a material endpoint result:
the first produced no distinguishable change in the observed latency range,
and the song-artifact slice reduced p95 `home-feed` by only 6.3%. Treating the
number of landed slices as progress would therefore be misleading; #8 remains
open until the endpoint gate passes.

The profile-prefetch slice makes its direct phases probe-visible as
`community-profile-prefetch`, `community-author-handles-{sum,max}`,
`community-derivative-{local-rows,global-rows,profiles}-{sum,max}`, alongside
the existing localization, aggregate derivative, and unaccounted timings.
Evaluate at least 50 cache-busted mixed-`best` first pages and report p50/p95,
not a latency range. The slice-specific production gate is:

1. p95 `community-author-handles-max` is at most 250ms, demonstrating that
   page-author handle hydration consumes the request-scoped prefetch rather
   than repeating remote profile reads.
2. p95 `community-fanout` falls at least 20% from 12.474s to at most 9.979s.
3. p50 `home-feed` does not regress by more than 10% from 11.283s.
4. A seven-page mixed-`best` walk contains no repeated `source_post_id`.

These are acceptance criteria for this slice, not a relaxation of #8's overall
40% / 5-second fanout gate. If the direct author-handle criterion passes but
the endpoint criterion does not, retain the deduplication only if it has no
measurable regression and use the newly exposed derivative-profile and
unaccounted p95 values to select the next target.

### Profile-prefetch production result

The profile-prefetch slice is present in the deployed API revision
`a15ed56529d9f597fe501a315a2247789d200ce9`. Eight sequential, cache-busted
`/feed/home/videos/public` first-page requests (each reported
`x-pirate-materialized-feed: bypass`) produced this sample:

| Metric | p50 | sample p95 (max) |
| --- | ---: | ---: |
| `home-feed` | 4.10s | 4.28s |
| `community-fanout` | 3.52s | 3.67s |
| `community-profile-prefetch` | 507ms | 784ms |

All eight requests reported `community-author-handles-sum=0` and
`community-derivative-profiles-sum=0`. Against the earlier four-request video
baseline (12.623–14.084s `home-feed`, 12.199–13.535s fanout), the observed
median fell by about 68% and the sample maximum by about 70%. The direct slice
criteria therefore pass for the video route: the new prefetch phase is live,
the duplicated profile phases disappear there, and the observed endpoint time
is below the 6-second target. This does not close the primary mixed Home gate.

This is strong directional evidence, not a population p95: the before sample
has four requests and the after sample has eight. Repeat a larger same-surface
sample before using the result for capacity planning. The remaining visible
cost is derivative global-row hydration (about 2.45–2.61s per request); treat
that as a separate, optional follow-up rather than reopening the profile
deduplication slice.

A subsequent 50-request cache-busted mixed `best` first-page probe reported
`x-pirate-materialized-feed: bypass` on every response, but
`community-profile-prefetch=0` on every response while author-handle and
derivative-profile phases remained in the multi-second sums. The mixed
projection SQL did not select `author_user_id` or `identity_mode`, so the
request-scoped prefetch had no IDs to load. API PR #1297 adds those existing
columns to both sides of the mixed keyset query and extends the PostgreSQL
fixture to pin the contract. Re-run the mixed 50-request gate only after that
fix is deployed.
