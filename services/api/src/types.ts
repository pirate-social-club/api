export type {
  AuthProof,
  Community,
  CommunityCreateAcceptedResponse,
  CompleteNamespaceVerificationSessionRequest,
  CompleteVerificationSessionRequest,
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
  Profile,
  RedditImportSummary,
  RedditVerification,
  SessionExchangeRequest,
  SessionExchangeResponse,
  StartNamespaceVerificationSessionRequest,
  StartVerificationSessionRequest,
  User,
  VerificationCapabilities,
  VerificationSession,
  WalletAttachmentSummary,
} from "@pirate/api-contracts"

type ContractCreateCommunityRequest = import("@pirate/api-contracts").CreateCommunityRequest
type ContractPost = import("@pirate/api-contracts").Post

export type CreateCommunityRequest = ContractCreateCommunityRequest & {
  description?: string | null
  membership_mode?: "open" | "request" | "gated"
  allow_anonymous_identity?: boolean
  anonymous_identity_scope?: "community_stable" | "thread_stable" | "post_ephemeral" | null
  default_age_gate_policy?: "none" | "18_plus"
  donation_policy?: unknown
  community_bootstrap?: unknown
  gate_rules?: Array<{
    scope?: "membership" | "viewer" | "posting"
    gate_family?: "token_holding" | "identity_proof"
    gate_type?: string
    proof_requirements?: Array<{
      proof_type?: string
      accepted_providers?: string[] | null
      accepted_mechanisms?: string[] | null
      config?: Record<string, unknown> | null
    }> | null
    chain_namespace?: string | null
    gate_config?: Record<string, unknown> | null
  }> | null
}

export type Post = ContractPost & {
  lyrics?: string | null
}

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
  HNS_VERIFICATION_PROVIDER?: string
  HNS_RESOLVER_HOST?: string
  HNS_VERIFICATION_TIMEOUT_MS?: string
  HNS_PIRATE_NS_HOSTS?: string
  HNS_ASSUME_EXPIRY_HORIZON_SUFFICIENT?: string
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
}

export type UpstreamIdentity = {
  provider: "jwt" | "privy"
  providerSubject: string
  providerUserRef: string | null
  walletAddresses: string[]
  selectedWalletAddress: string | null
}
