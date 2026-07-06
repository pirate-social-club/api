import type { ShardRpc } from "@pirate/api-shared"
import type { RateLimiterBinding } from "./lib/rate-limit"

export type Env = {
  // Runtime
  BUILD_GIT_REF?: string
  BUILD_GIT_SHA?: string
  BUILD_TIMESTAMP?: string
  ENVIRONMENT?: string
  DEV_MEMORY_STORE_ENABLED?: string
  CONTROL_PLANE_DATABASE_URL?: string
  CORS_ALLOWED_ORIGINS?: string
  PIRATE_ANDROID_KARAOKE_ORIGINS?: string
  MATERIALIZED_PUBLIC_HOME_FEED_LOCALES?: string
  PIRATE_ADMIN_TOKEN?: string
  SENTRY_DSN?: string

  // Analytics
  ANALYTICS_ENABLED?: string
  ANALYTICS_HMAC_SECRET?: string
  TINYBIRD_HOST?: string
  TINYBIRD_INGEST_TOKEN?: string
  TINYBIRD_READ_TOKEN?: string
  TINYBIRD_EVENTS_DATASOURCE?: string

  // Community databases and provisioning
  CREDENTIAL_WRAP_KEY?: string
  CREDENTIAL_WRAP_KEY_VERSION?: string
  LOCAL_COMMUNITY_DB_ROOT?: string
  /** PR2/PR3: read+write RPC binding to the community D1 shard Worker (absent until provisioned). */
  COMMUNITY_D1_SHARD?: ShardRpc
  /**
   * Step 5: shared secret for the shard's admin RPCs, consulted by the
   * D1-native reconciler scheduled task (reconciler-host.ts). Must equal the
   * shard's own SHARD_ADMIN_TOKEN secret.
   */
  SHARD_ADMIN_TOKEN?: string
  /**
   * Dedicated reconciler hosts set this to "true" so their cron runs only D1
   * provisioning reconciliation. Main API workers must leave it unset so normal
   * scheduled tasks, including community job processing, still run.
   */
  COMMUNITY_D1_RECONCILER_ONLY?: string
  /**
   * Region label recorded on D1-native routing rows (satisfies the 0117
   * `chk_d1_fields` NOT NULL). Informational — actual D1 placement is set
   * out-of-band by the shard's static `wrangler d1_databases` bindings.
   */
  COMMUNITY_D1_SHARD_REGION?: string
  COMMUNITY_PROVISION_DEFAULT_GROUP_LOCATION?: string
  COMMUNITY_PROVISION_ALLOWED_GROUP_LOCATIONS?: string

  // Auth and identity
  JWT_BASED_AUTH_ENABLED?: string
  JWT_BASED_AUTH_SHARED_SECRET?: string
  JWT_BASED_AUTH_ISSUERS?: string
  JWT_BASED_AUTH_AUDIENCE?: string
  AUTH_UPSTREAM_JWT_ISSUER?: string
  AUTH_UPSTREAM_JWT_AUDIENCE?: string
  AUTH_UPSTREAM_JWT_SHARED_SECRET?: string
  // Staging-only test issuer (see lib/auth/staging-test-auth.ts). Fails closed unless
  // ENVIRONMENT=staging AND STAGING_TEST_AUTH_ENABLED opted in AND the secret is set.
  STAGING_TEST_AUTH_ENABLED?: string
  STAGING_TEST_JWT_SHARED_SECRET?: string
  PIRATE_APP_JWT_PRIVATE_KEY?: string
  PIRATE_APP_JWT_PUBLIC_KEY?: string
  PIRATE_APP_JWT_ISSUER?: string
  PIRATE_APP_JWT_AUDIENCE?: string
  PIRATE_APP_JWT_TTL_SECONDS?: string
  PIRATE_WEB_PUBLIC_ORIGIN?: string
  OAUTH_DEVICE_CODE_TTL_SECONDS?: string
  OAUTH_DEVICE_POLL_INTERVAL_SECONDS?: string
  OAUTH_DEVICE_REFRESH_TOKEN_TTL_SECONDS?: string
  PRIVY_APP_ID?: string
  PRIVY_APP_SECRET?: string
  PRIVY_API_URL?: string
  PRIVY_JWT_VERIFICATION_KEY?: string
  REDDIT_PROFILE_CHECK_USER_AGENT?: string
  REDDIT_PULLPUSH_BASE_URL?: string
  VERY_API_URL?: string
  VERY_APP_ID?: string
  VERY_NATIVE_OAUTH_ENABLED?: string
  VERY_OAUTH_CLIENT_ID?: string
  VERY_OAUTH_CLIENT_SECRET?: string
  VERY_OAUTH_ISSUER?: string
  VERY_OAUTH_JWKS_URL?: string
  VERY_OAUTH_REDIRECT_URI?: string
  VERY_OAUTH_TOKEN_URL?: string
  VERY_NATIVE_AUTH_CODE_TTL_SECONDS?: string
  VERY_VERIFY_URL?: string
  VERY_TRUST_BRIDGE_COMPLETION_ON_VERIFIER_5XX?: string
  VERY_TRUST_LOCAL_WIDGET_COMPLETION?: string
  VERIFICATION_DEBUG_LOGS?: string
  PLATFORM_APPROVED_KYA_PROVIDERS?: string
  CLAWKEY_API_URL?: string
  SELF_APP_NAME?: string
  SELF_ENDPOINT?: string
  SELF_ENDPOINT_TYPE?: string
  ZKPASSPORT_DOMAIN?: string
  ZKPASSPORT_SCOPE?: string
  ZKPASSPORT_LOGO_URL?: string
  ZKPASSPORT_DEV_MODE?: string
  ZKPASSPORT_VALIDITY_SECONDS?: string
  ZKPASSPORT_VERIFIER_URL?: string
  ZKPASSPORT_VERIFIER_SHARED_SECRET?: string
  ZKPASSPORT_VERIFIER_TIMEOUT_MS?: string
  ZKPASSPORT_LOCAL_VERIFY_ENABLED?: string
  ZKPASSPORT_LOCAL_VERIFY_WRITING_DIRECTORY?: string
  VERY_BRIDGE_API_URL?: string
  PASSPORT_API_URL?: string
  PASSPORT_API_KEY?: string
  PASSPORT_SCORER_ID?: string
  ALTCHA_HMAC_SECRET?: string
  ALTCHA_HMAC_KEY_SECRET?: string
  ALTCHA_POW_COST?: string
  ALTCHA_POW_COUNTER_MIN?: string
  ALTCHA_POW_COUNTER_MAX?: string
  ALTCHA_CHALLENGE_TTL_SECONDS?: string
  ALTCHA_CHALLENGE_RATE_LIMIT?: string
  ALTCHA_CHALLENGE_RATE_LIMIT_WINDOW_SECONDS?: string
  TELEGRAM_BOT_USERNAME?: string
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_WEBHOOK_SECRET?: string
  TELEGRAM_BOT_INTEGRATION_SECRET?: string
  TELEGRAM_SETUP_INTENT_TTL_SECONDS?: string

  // Media storage
  FILEBASE_S3_ACCESS_KEY?: string
  FILEBASE_S3_SECRET_KEY?: string
  FILEBASE_S3_ENDPOINT?: string
  FILEBASE_S3_REGION?: string
  FILEBASE_MEDIA_BUCKET?: string
  PIRATE_API_PUBLIC_ORIGIN?: string
  IPFS_GATEWAY_URL?: string
  SWARM_BEE_API_URL?: string
  SWARM_POSTAGE_BATCH_ID?: string
  SWARM_FEED_PRIVATE_KEY?: string
  SWARM_FEED_TOPIC_NAMESPACE?: string

  // EVM and commerce
  ETHEREUM_RPC_URL?: string
  COURTYARD_API_URL?: string
  COURTYARD_INVENTORY_CACHE_TTL_MS?: string
  BASE_MAINNET_RPC_URL?: string
  BASE_SEPOLIA_RPC_URL?: string
  PIRATE_CHECKOUT_OPERATOR_ADDRESS?: string
  PIRATE_CHECKOUT_OPERATOR_PRIVATE_KEY?: string
  PIRATE_CHECKOUT_RPC_URL?: string
  PIRATE_CHECKOUT_SOURCE_CHAIN_ID?: string
  PIRATE_CHECKOUT_USDC_TOKEN_ADDRESS?: string
  // Booking custody/settlement can be decoupled from the global commerce checkout chain.
  // Missing booking-specific config fails closed instead of falling back to PIRATE_CHECKOUT_*.
  PIRATE_BOOKING_SETTLEMENT_OPERATOR_ADDRESS?: string
  PIRATE_BOOKING_SETTLEMENT_OPERATOR_PRIVATE_KEY?: string
  PIRATE_BOOKING_SETTLEMENT_RPC_URL?: string
  PIRATE_BOOKING_SETTLEMENT_CHAIN_ID?: string
  PIRATE_BOOKING_SETTLEMENT_USDC_TOKEN_ADDRESS?: string
  // Opt out of the canonical-USDC pin (only honor a non-canonical token override when "true").
  PIRATE_BOOKING_SETTLEMENT_ALLOW_TOKEN_OVERRIDE?: string
  // Caps RPC receipt waits for routed checkout funding confirmation. Paid
  // handle claims can be retried with the same funding_tx_ref after timeout.
  // Use 15000-30000 for pilot smoke.
  PIRATE_CHECKOUT_TX_WAIT_TIMEOUT_MS?: string

  // Public name rate limiting
  PUBLIC_NAME_QUOTE_RATE_LIMIT_IP?: string
  PUBLIC_NAME_QUOTE_RATE_LIMIT_WALLET?: string
  PUBLIC_NAME_QUOTE_RATE_LIMIT_WINDOW_SECONDS?: string

  // Story and song processing
  STORY_CHAIN_ID?: string
  STORY_RPC_URL?: string
  STORY_RPC_FALLBACK_URLS?: string
  STORY_COMPOSITE_READ_CONDITION_ADDRESS?: string
  STORY_ROYALTY_SPG_NFT_CONTRACT?: string
  STORY_ROYALTY_COMMERCIAL_REV_SHARE_PCT?: string
  STORY_ROYALTY_DEFAULT_MINTING_FEE_WEI?: string
  STORY_ROYALTY_MAX_LICENSE_TOKENS?: string
  STORY_ROYALTY_POLICY_LAP_ADDRESS?: string
  COMMUNITY_JOB_WORKER_INTERVAL_MS?: string
  COMMUNITY_JOB_WORKER_MAX_JOBS_PER_COMMUNITY?: string
  COMMUNITY_JOB_WORKER_MAX_COMMUNITIES_PER_TICK?: string
  // Defaults to async outside local/test. Set false as a production kill switch; set true in tests to opt into the async path.
  STORY_LOCKED_DELIVERY_ASYNC?: string
  SONG_PREVIEW_SERVICE?: Fetcher
  SONG_PREVIEW_SERVICE_URL?: string
  SONG_PREVIEW_SHARED_SECRET?: string
  SONG_PREVIEW_SERVICE_TIMEOUT_MS?: string
  SONG_PREVIEW_FFMPEG_BIN?: string
  SONG_PREVIEW_FFPROBE_BIN?: string
  VIDEO_ANALYSIS_MAX_SOURCE_BYTES?: string
  VIDEO_MEDIA_ANALYSIS_ENABLED?: string
  AGORA_APP_ID?: string
  AGORA_APP_CERTIFICATE?: string
  AGORA_CLOUD_RECORDING_BASE_URL?: string
  AGORA_CLOUD_RECORDING_CUSTOMER_ID?: string
  AGORA_CLOUD_RECORDING_CUSTOMER_SECRET?: string
  AGORA_CLOUD_RECORDING_STORAGE_VENDOR?: string
  AGORA_CLOUD_RECORDING_STORAGE_REGION?: string
  AGORA_CLOUD_RECORDING_STORAGE_BUCKET?: string
  AGORA_CLOUD_RECORDING_STORAGE_ACCESS_KEY?: string
  AGORA_CLOUD_RECORDING_STORAGE_SECRET_KEY?: string
  AGORA_CLOUD_RECORDING_STORAGE_ENDPOINT?: string
  AGORA_CLOUD_RECORDING_STORAGE_FILE_PREFIX?: string
  AGORA_CLOUD_RECORDING_RESOURCE_EXPIRED_HOURS?: string
  AGORA_CLOUD_RECORDING_CAPTURE_S3_ENDPOINT?: string
  AGORA_CLOUD_RECORDING_CAPTURE_S3_REGION?: string
  LIVE_ROOM_AGORA_TOKEN_TTL_SECONDS?: string
  LIVE_ROOM_JACKTRIP_HOST?: string
  LIVE_ROOM_JACKTRIP_HOST_TEMPLATE?: string
  LIVE_ROOM_JACKTRIP_PORT?: string
  LIVE_ROOM_JACKTRIP_BIND_PORT?: string
  LIVE_ROOM_JACKTRIP_QUALITY?: string
  LIVE_ROOM_JACKTRIP_BUFFER_STRATEGY?: string
  LIVE_ROOM_JACKTRIP_LINUX_AUDIO_SETUP_RECOMMENDED?: string
  LIVE_ROOM_RUNTIME?: DurableObjectNamespace
  KARAOKE_SESSION_RUNTIME?: DurableObjectNamespace
  // Cloudflare native rate limiter (configured under `ratelimits` in wrangler).
  LINK_PREVIEW_RATE_LIMITER?: RateLimiterBinding
  KARAOKE_GATEWAY_SIGNING_KEY?: string
  ELEVENLABS_STT_MODEL?: string
  ELEVENLABS_STT_WEBSOCKET_URL?: string
  // Singleton lease arbiter ensuring only one scheduled (cron) batch runs at a time.
  SCHEDULED_CRON_LOCK?: DurableObjectNamespace
  // Wallet-scoped serial signer/nonce authority for booking operator USDC settlement.
  OPERATOR_SIGNING_COORDINATOR?: DurableObjectNamespace
  // Unattended booking-settlement cron gate. Missing/empty/invalid = disabled; only "true" enables.
  // Stays off until migrations 1103/1104 are applied and the Base Sepolia smoke has passed.
  BOOKINGS_SETTLEMENT_CRON_ENABLED?: string
  // Legacy community-scoped booking settlement sweep. The global booking path is canonical; this
  // remains fail-closed unless an operator explicitly opts into sweeping old community D1 rows.
  LEGACY_COMMUNITY_BOOKINGS_SETTLEMENT_CRON_ENABLED?: string
  // When true, attendance-ambiguous due bookings are moved to disputed/pending operator review
  // instead of being left untouched by the settlement cron.
  BOOKING_SETTLEMENT_AMBIGUOUS_REVIEW_ENABLED?: string
  STORY_TX_WAIT_TIMEOUT_MS?: string
  STORY_RUNTIME_SIGNER_MIN_BALANCE_WEI?: string
  STORY_RUNTIME_SIGNER_TARGET_BALANCE_WEI?: string
  // Scheduled balance watchdog for the Story runtime signer wallets.
  STORY_RUNTIME_FUNDING_WATCHDOG_INTERVAL_MS?: string
  STORY_RUNTIME_FUNDING_WATCHDOG_TX_MARGIN?: string
  STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI?: string
  STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI?: string
  STORY_DIRECT_TX_GAS_LIMIT_MAX?: string
  STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS?: string
  STORY_RUNTIME_PRIVATE_KEY?: string
  STORY_OPERATOR_PRIVATE_KEY?: string
  STORY_OPERATOR_PKP_ADDRESS?: string
  STORY_OPERATOR_PKP_PUBLIC_KEY?: string
  STORY_OPERATOR_ACTION_CID_PUBLISH_ASSET_VERSION?: string
  LIT_CHIPOTLE_API_BASE_URL?: string
  LIT_CHIPOTLE_OPERATOR_API_KEY?: string
  STORY_CDR_WRITER_PRIVATE_KEY?: string
  STORY_CDR_WRITER_PKP_ADDRESS?: string
  STORY_CDR_WRITER_PKP_PUBLIC_KEY?: string
  STORY_CDR_WRITER_ACTION_CID_ALLOCATE_WRITE?: string
  LIT_CHIPOTLE_CDR_WRITER_API_KEY?: string
  STORY_ACCESS_CONTROLLER_PRIVATE_KEY?: string
  STORY_ACCESS_CONTROLLER_PKP_ADDRESS?: string
  STORY_ACCESS_CONTROLLER_PKP_PUBLIC_KEY?: string
  STORY_ACCESS_CONTROLLER_ACTION_CID_SIGN_ACCESS_PROOF?: string
  LIT_CHIPOTLE_ACCESS_CONTROLLER_API_KEY?: string
  MUSIC_PURCHASE_STORY_SETTLEMENT_PRIVATE_KEY?: string
  MUSIC_PURCHASE_STORY_SETTLEMENT_PKP_ADDRESS?: string
  MUSIC_PURCHASE_STORY_SETTLEMENT_PKP_ID?: string
  MUSIC_PURCHASE_STORY_SETTLEMENT_PKP_PUBLIC_KEY?: string
  LIT_CHIPOTLE_STORY_SETTLEMENT_API_KEY?: string
  STORY_SETTLEMENT_ACTION_CID_SETTLE?: string
  STORY_SETTLEMENT_ACTION_CID_ROYALTY_SYNC?: string

  // Payouts and funding
  ENDAOMENT_PAYOUT_PRIVATE_KEY?: string
  ENDAOMENT_RPC_URL?: string
  ENDAOMENT_CHAIN_ID?: string
  ENDAOMENT_USDC_TOKEN_ADDRESS?: string
  ENDAOMENT_REGISTRY_ADDRESS?: string
  ENDAOMENT_TX_WAIT_TIMEOUT_MS?: string
  STORY_CONTRACT_OWNER_PRIVATE_KEY?: string
  STORY_RUNTIME_FUNDER_PRIVATE_KEY?: string

  // AI and external analysis
  OPENAI_API_KEY?: string
  OPENAI_MODERATION_BASE_URL?: string
  OPENAI_MODERATION_MODEL?: string
  OPENAI_MODERATION_SEXUAL_MINORS_BLOCK_THRESHOLD?: string
  OPENAI_MODERATION_TIMEOUT_MS?: string
  OPENROUTER_API_KEY?: string
  OPENROUTER_BASE_URL?: string
  OPENROUTER_MODEL?: string
  SONG_STUDY_GENERATION_TARGET_LANGUAGE_LIMIT?: string
  SONG_STUDY_ATTEMPT_TIMING_LOGS?: string
  SONG_STUDY_DUE_REVIEW_SERVING_ENABLED?: string
  SONG_STUDY_STREAK_WRITES_ENABLED?: string
  OPENROUTER_TIMEOUT_MS?: string
  OPENROUTER_VISUAL_POLICY_MODEL?: string
  OPENROUTER_VISUAL_POLICY_TIMEOUT_MS?: string
  OPENROUTER_TRANSLATION_MODEL?: string
  OPENROUTER_TRANSLATION_MAX_COMPLETION_TOKENS?: string
  OPENROUTER_STUDY_GENERATION_CHUNK_SIZE?: string
  OPENROUTER_TRANSLATION_TIMEOUT_MS?: string
  OPENROUTER_LINK_SUMMARY_MODEL?: string
  OPENROUTER_LINK_SUMMARY_TIMEOUT_MS?: string
  OPENROUTER_LINK_SUMMARY_TRANSLATION_MODEL?: string
  OPENROUTER_LINK_SUMMARY_TRANSLATION_TIMEOUT_MS?: string
  OPENROUTER_LABELING_MODEL?: string
  OPENROUTER_LABELING_TIMEOUT_MS?: string
  FIRECRAWL_API_KEY?: string
  GEOAPIFY_API_KEY?: string
  ELEVENLABS_API_KEY?: string
  ELEVENLABS_FORCE_ALIGNMENT_URL?: string
  ELEVENLABS_TIMEOUT_MS?: string
  ACRCLOUD_ACCESS_KEY?: string
  ACRCLOUD_ACCESS_SECRET?: string
  ACRCLOUD_HOST?: string
  ACRCLOUD_IDENTIFY_PATH?: string
  ACRCLOUD_TIMEOUT_MS?: string
  ACRCLOUD_PERSONAL_ACCESS_TOKEN?: string
  ACRCLOUD_BUCKET_ID?: string
  ACRCLOUD_CONSOLE_BASE_URL?: string

  // Namespace verifiers
  SPACES_VERIFIER_BASE_URL?: string
  SPACES_VERIFIER_AUTH_TOKEN?: string
  SPACES_VERIFIER_CHALLENGE_DOMAIN?: string
  SPACES_CHALLENGE_TTL_HOURS?: string
  HNS_VERIFIER_BASE_URL?: string
  HNS_VERIFIER_AUTH_TOKEN?: string
  HNS_CHALLENGE_TTL_HOURS?: string
}
