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

## Community-bookings product decision

Do not use these findings to justify unmounting or deleting the community-scoped booking API. The routes remain live on main.

- `booking-attendance-evaluator.ts` — `DEFAULT_ATTENDANCE_CONFIG`.
- `booking-chain-config.ts` — `resolveBookingSettlementChainName`.
- `booking-confirm-service.ts` — `PaymentInstructions`.
- `booking-hold-service.ts` — `BookingHold`.
- `booking-payment-intent-service.ts` — `PaymentIntentStatus`.
- `booking-read-service.ts` — `BookingSettlementReviewResolution`.
- `booking-session-service.ts` — `deriveBookingChannel`.
- `booking-settlement-cron.ts` — `processCommunityBookingSettlements`, `ProcessCommunityFn`.
- `booking-settlement-effects.ts` — `BookingSettlementEffectStatus`.
- `booking-settlement-evaluator.ts` — `isBookingSettlementAmbiguousReviewEnabled`.
- `operator-signing-coordinator-do.ts` — `OperatorEffectKind`, `GasParams`, `TxLiveness`.

If product approves global-only bookings, remove the route registration and subtree in a dedicated breaking-change PR with route-contract review. Otherwise only narrow these individual exports.

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
| Community bookings | Existing `tests/routes/communities/community-bookings-*.test.ts` and `tests/lib/communities/bookings/*.test.ts` |
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
