export type {
  AuthProof,
  Community,
  CommunityCreateAcceptedResponse,
  CompleteNamespaceVerificationSessionRequest,
  CompleteVerificationSessionRequest,
  CreateCommunityRequest,
  CreatePostRequest,
  ErrorResponse,
  GlobalHandle,
  Job,
  LocalizedPostResponse,
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
  SessionExchangeRequest,
  SessionExchangeResponse,
  StartNamespaceVerificationSessionRequest,
  StartVerificationSessionRequest,
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
  TURSO_CONTROL_PLANE_DATABASE_URL?: string
  TURSO_CONTROL_PLANE_DATABASE_NAME?: string
  TURSO_CONTROL_PLANE_AUTH_TOKEN?: string
  LOCAL_COMMUNITY_DB_ROOT?: string
  REGISTRY_PUBLISHER_URL?: string
  REGISTRY_PUBLISHER_AUTH_TOKEN?: string
  REGISTRY_PUBLISHER_TIMEOUT_MS?: string
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
  SPACES_VERIFIER_BASE_URL?: string
  SPACES_VERIFIER_AUTH_TOKEN?: string
  SPACES_VERIFIER_CHALLENGE_DOMAIN?: string
  HNS_VERIFIER_BASE_URL?: string
  HNS_VERIFIER_AUTH_TOKEN?: string
}

export type UpstreamIdentity = {
  provider: "jwt" | "privy"
  providerSubject: string
  providerUserRef: string | null
  walletAddresses: string[]
  selectedWalletAddress: string | null
}
