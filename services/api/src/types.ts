export type {
  Asset,
  AssetAccessResponse,
  AuthProof,
  Community,
  CommunityCreateAcceptedResponse,
  CommunityListing,
  CommunityListingListResponse,
  CommunityMoneyPolicy,
  CommunityPurchase,
  CommunityPurchaseListResponse,
  CommunityPurchaseQuote,
  CommunityPurchaseQuotePreflight,
  CommunityPurchaseQuotePreflightRequest,
  CommunityPurchaseQuoteRequest,
  CommunityPurchaseSettlement,
  CommunityPurchaseSettlementFailure,
  CommunityPurchaseSettlementFailureRequest,
  CommunityPurchaseSettlementRequest,
  CommunityPricingPolicy,
  CommunityPreview,
  CompleteNamespaceVerificationSessionRequest,
  CompleteVerificationSessionRequest,
  CreateCommunityRequest,
  CreateCommunityListingRequest,
  CreateSongArtifactBundleRequest,
  CreateSongArtifactUploadRequest,
  CreatePostRequest,
  ErrorResponse,
  GateFailureDetails,
  GlobalHandle,
  Job,
  JoinEligibility,
  LinkedHandle,
  LocalizedPostResponse,
  MembershipGateSummary,
  NamespaceVerification,
  NamespaceVerificationAssertions,
  NamespaceVerificationCapabilities,
  NamespaceVerificationSession,
  OnboardingStatus,
  Post,
  Profile,
  RedditImportSummary,
  RedditVerification,
  RequestedVerificationCapability,
  SelfVerificationDisclosures,
  SelfVerificationLaunch,
  SessionExchangeRequest,
  SessionExchangeResponse,
  SongArtifactBundle,
  SongArtifactUpload,
  StartNamespaceVerificationSessionRequest,
  StartVerificationSessionRequest,
  UpdateCommunityListingRequest,
  UpdateCommunityMoneyPolicyRequest,
  UpdateCommunityPricingPolicyRequest,
  User,
  VerificationCapabilities,
  VerificationIntent,
  VerificationSession,
  VerificationSessionLaunch,
  VeryWidgetLaunch,
  WalletAttachmentSummary,
} from "@pirate/api-contracts"

export type HandleUpgradeQuote = {
  desired_label: string
  tier: "standard" | "premium"
  price_usd: number
  eligible: boolean
  reason?: string | null
}

export type Env = {
  ENVIRONMENT?: string
  DEV_MEMORY_STORE_ENABLED?: string
  CONTROL_PLANE_DATABASE_URL?: string
  TURSO_CONTROL_PLANE_DATABASE_NAME?: string
  TURSO_CONTROL_PLANE_AUTH_TOKEN?: string
  TURSO_COMMUNITY_DB_WRAP_KEY?: string
  TURSO_COMMUNITY_DB_WRAP_KEY_VERSION?: string
  LOCAL_COMMUNITY_DB_ROOT?: string
  REGISTRY_PUBLISHER_URL?: string
  REGISTRY_PUBLISHER_AUTH_TOKEN?: string
  REGISTRY_PUBLISHER_TIMEOUT_MS?: string
  COMMUNITY_PROVISION_OPERATOR_BASE_URL?: string
  COMMUNITY_PROVISION_OPERATOR_AUTH_TOKEN?: string
  COMMUNITY_PROVISION_OPERATOR_TIMEOUT_MS?: string
  COMMUNITY_PROVISION_DEFAULT_GROUP_LOCATION?: string
  JWT_BASED_AUTH_ENABLED?: string
  JWT_BASED_AUTH_SHARED_SECRET?: string
  JWT_BASED_AUTH_ISSUERS?: string
  JWT_BASED_AUTH_AUDIENCE?: string
  AUTH_UPSTREAM_JWT_ISSUER?: string
  AUTH_UPSTREAM_JWT_AUDIENCE?: string
  AUTH_UPSTREAM_JWT_SHARED_SECRET?: string
  PIRATE_APP_JWT_PRIVATE_KEY?: string
  PIRATE_APP_JWT_PUBLIC_KEY?: string
  PIRATE_APP_JWT_ISSUER?: string
  PIRATE_APP_JWT_AUDIENCE?: string
  PIRATE_APP_JWT_TTL_SECONDS?: string
  PRIVY_APP_ID?: string
  PRIVY_APP_SECRET?: string
  PRIVY_API_URL?: string
  PRIVY_JWT_VERIFICATION_KEY?: string
  REDDIT_PROFILE_CHECK_USER_AGENT?: string
  REDDIT_PULLPUSH_BASE_URL?: string
  VERY_API_URL?: string
  VERY_API_KEY?: string
  VERY_APP_ID?: string
  VERY_VERIFY_URL?: string
  VERY_SESSIONS_URL?: string
  SELF_API_URL?: string
  SELF_API_KEY?: string
  SELF_APP_NAME?: string
  SELF_ENDPOINT?: string
  SELF_ENDPOINT_TYPE?: string
  FILEBASE_S3_ACCESS_KEY?: string
  FILEBASE_S3_SECRET_KEY?: string
  FILEBASE_S3_BUCKET_MUSIC?: string
  FILEBASE_S3_ENDPOINT?: string
  FILEBASE_S3_REGION?: string
  FILEBASE_MEDIA_BUCKET?: string
  IPFS_GATEWAY_URL?: string
  ETHEREUM_RPC_URL?: string
  STORY_CHAIN_ID?: string
  STORY_RPC_URL?: string
  STORY_TX_WAIT_TIMEOUT_MS?: string
  STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI?: string
  STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI?: string
  STORY_DIRECT_TX_GAS_LIMIT_MAX?: string
  STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS?: string
  STORY_OPERATOR_PKP_ADDRESS?: string
  STORY_OPERATOR_PKP_PUBLIC_KEY?: string
  STORY_OPERATOR_ACTION_CID_PUBLISH_ASSET_VERSION?: string
  LIT_CHIPOTLE_API_BASE_URL?: string
  LIT_CHIPOTLE_OPERATOR_API_KEY?: string
  STORY_CDR_WRITER_PKP_ADDRESS?: string
  STORY_CDR_WRITER_PKP_PUBLIC_KEY?: string
  STORY_CDR_WRITER_ACTION_CID_ALLOCATE_WRITE?: string
  LIT_CHIPOTLE_CDR_WRITER_API_KEY?: string
  STORY_ACCESS_CONTROLLER_PKP_ADDRESS?: string
  STORY_ACCESS_CONTROLLER_PKP_PUBLIC_KEY?: string
  STORY_ACCESS_CONTROLLER_ACTION_CID_SIGN_ACCESS_PROOF?: string
  LIT_CHIPOTLE_ACCESS_CONTROLLER_API_KEY?: string
  MUSIC_PURCHASE_STORY_SETTLEMENT_PKP_ADDRESS?: string
  MUSIC_PURCHASE_STORY_SETTLEMENT_PKP_PUBLIC_KEY?: string
  LIT_CHIPOTLE_STORY_SETTLEMENT_API_KEY?: string
  STORY_SETTLEMENT_ACTION_CID_SETTLE?: string
  STORY_SETTLEMENT_ACTION_CID_ROYALTY_SYNC?: string
  STORY_CONTRACT_OWNER_PRIVATE_KEY?: string
  OPENROUTER_API_KEY?: string
  OPENROUTER_BASE_URL?: string
  OPENROUTER_MODEL?: string
  OPENROUTER_TIMEOUT_MS?: string
  OPENAI_API_KEY?: string
  OPENAI_BASE_URL?: string
  OPENAI_MODERATION_MODEL?: string
  OPENAI_TIMEOUT_MS?: string
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
  SPACES_VERIFIER_BASE_URL?: string
  SPACES_VERIFIER_AUTH_TOKEN?: string
  SPACES_VERIFIER_CHALLENGE_DOMAIN?: string
  HNS_VERIFIER_BASE_URL?: string
  HNS_VERIFIER_AUTH_TOKEN?: string
  HNS_CHALLENGE_TTL_HOURS?: string
}

export type UpstreamIdentity = {
  provider: "jwt" | "privy"
  providerSubject: string
  providerUserRef: string | null
  walletAddresses: string[]
  selectedWalletAddress: string | null
}
