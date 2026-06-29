// GENERATED FILE. Edit specs/api/src/** and run `rtk bun specs/api/scripts/generate-api-contracts.ts`.

export type ErrorResponse = {
  code: "bad_request" | "auth_error" | "payment_required" | "verification_required" | "eligibility_failed" | "gate_failed" | "posting_trust_tier_too_low" | "posting_quota_exhausted" | "analysis_blocked" | "analysis_review_required" | "label_required" | "invalid_label_selection" | "label_required_but_none_applicable" | "conflict" | "not_found" | "rate_limited" | "payment_failed" | "settlement_pending" | "provider_unavailable" | "internal_error";
  message: string;
  retryable?: boolean;
  details?: (Record<string, unknown>) | null;
};

export type AuthProof = ({
  type: "privy_access_token";
  privy_access_token: string;
  privy_identity_token?: string | null;
  wallet_address?: string | null;
} | {
  type: "jwt_based_auth";
  jwt: string;
});

export type SessionExchangeRequest = {
  proof: ({
    type: "privy_access_token";
    privy_access_token: string;
    privy_identity_token?: string | null;
    wallet_address?: string | null;
  } | {
    type: "jwt_based_auth";
    jwt: string;
  });
};

export type OAuthDeviceAuthorizeRequest = {
  client_id: "freedom-desktop";
  scope?: string;
};

export type OAuthDeviceAuthorizeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
};

export type OAuthDeviceVerifyRequest = {
  user_code: string;
};

export type OAuthDeviceVerifyResponse = {
  client_id: string;
  scope: string;
  status: "authorized";
  user_code: string;
};

export type OAuthDeviceTokenRequest = ({
  grant_type?: "urn:ietf:params:oauth:grant-type:device_code";
  client_id: "freedom-desktop";
  device_code: string;
} | {
  grant_type: "refresh_token";
  client_id: "freedom-desktop";
  refresh_token: string;
});

export type OAuthDeviceTokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_expires_in: number;
  scope: string;
};

export type OAuthDeviceAuthorizationPendingResponse = {
  error: "authorization_pending";
  error_description: string;
  interval: number;
};

export type VerificationCapabilities = {
  unique_human: VerificationCapabilityState;
  age_over_18: (VerifiedCapabilityState & {
    proof_type?: "age_over_18" | null;
  });
  minimum_age: (VerifiedCapabilityState & {
    proof_type?: "minimum_age" | null;
    value?: number | null;
  });
  nationality: (VerifiedCapabilityState & {
    proof_type?: "nationality" | null;
    value?: string | null;
  });
  gender: (VerifiedCapabilityState & {
    value?: "M" | "F" | null;
    proof_type?: "gender" | null;
  });
  wallet_score: WalletScoreCapabilityState;
};

export type User = {
  id: string;
  object: "user";
  community_posting_state?: ({
    community_ref?: string;
    community?: string;
    has_created_text_post?: boolean;
  }) | null;
  primary_wallet_attachment?: string | null;
  verification_state: "unverified" | "pending" | "verified" | "reverification_required";
  capability_provider?: "self" | "very" | null;
  verification_capabilities: VerificationCapabilities;
  verified_at?: number | null;
  created: number;
};

export type GlobalHandle = {
  id: string;
  object: "global_handle";
  label: string;
  tier: "generated" | "standard" | "premium";
  status: "active" | "redirect" | "retired";
  issuance_source: "generated_signup" | "free_cleanup_rename" | "reddit_verified_claim" | "paid_upgrade" | "admin_grant";
  redirect_target_global_handle?: string | null;
  price_paid_cents?: number | null;
  free_rename_consumed?: boolean;
  issued_at: number;
  replaced_at?: number | null;
};

export type Profile = {
  id: string;
  object: "profile";
  display_name?: string | null;
  avatar_ref?: string | null;
  avatar_source?: "ens" | "upload" | "none" | null;
  cover_ref?: string | null;
  cover_source?: "ens" | "upload" | "none" | null;
  bio?: string | null;
  bio_source?: "ens" | "manual" | "none" | null;
  preferred_locale?: string | null;
  display_verified_nationality_badge?: boolean | null;
  nationality_badge_country?: string | null;
  linked_handles?: Array<LinkedHandle> | null;
  primary_public_handle?: LinkedHandle | null;
  primary_wallet_address?: string | null;
  xmtp_inbox?: string | null;
  verification_capabilities?: VerificationCapabilities | null;
  global_handle: GlobalHandle;
  created: number;
};

export type PublicProfileResolution = {
  profile: Profile;
  requested_handle_label: string;
  resolved_handle_label: string;
  is_canonical: boolean;
  created_communities: Array<{
    community: string;
    display_name: string;
    route_slug?: string | null;
    created: number;
  }>;
};

export type ProfileActivityPostPage = {
  kind: "post";
  post: LocalizedPostResponse;
  community: CommunityPreview;
  created: number;
};

export type ProfileActivityCommentPage = {
  kind: "comment";
  comment: CommentListItem;
  thread_root_post: LocalizedPostResponse;
  community: CommunityPreview;
  created: number;
};

export type ProfileActivityResponse = {
  tab: "overview" | "posts" | "comments";
  posts: Array<ProfileActivityPostPage>;
  comments: Array<ProfileActivityCommentPage>;
  overview_items: Array<(ProfileActivityPostPage | ProfileActivityCommentPage)>;
  next_cursor: string | null;
};

export type WalletIdentityPublicName = {
  id: string;
  label: string;
  label_normalized: string;
  status: "active";
  owner_kind: "wallet";
  owner_wallet_address: string;
  chain_ref: string;
  price_paid_cents: number;
  currency: "USD";
  issued_at: number;
  expires_at: number | null;
  pirate_user_id: string | null;
};

export type WalletIdentity = {
  object: "wallet_identity";
  chain_ref: string;
  wallet_address: string;
  display_label: string | null;
  public_names: Array<WalletIdentityPublicName>;
};

export type WalletIdentityRedirect = {
  object: "wallet_identity_redirect";
  chain_ref: string;
  wallet_address: string;
  profile: string;
  profile_handle: string;
};

export type WalletIdentityResponse = (WalletIdentity | WalletIdentityRedirect);

export type PublicNameQuoteRequest = {
  desired_label: string;
  buyer_wallet_address: string;
};

export type PublicNamePaymentInstructions = {
  chain: {
    chain_namespace: "eip155";
    chain_id: number;
    display_name: string;
  };
  token_address: string;
  recipient_address: string;
  amount_atomic: string;
  amount_display: string;
};

export type PublicNameQuote = {
  quote: string;
  desired_label: string;
  label_normalized: string;
  buyer: {
    kind: "wallet";
    wallet_address: string;
    chain_ref: string;
  };
  price_cents: number;
  currency: "USD";
  eligible: true;
  reason: string | null;
  policy_version: string;
  pricing_tier?: string | null;
  quote_ttl_seconds: number;
  quoted_at: number;
  expires_at: number;
  payment_instructions: PublicNamePaymentInstructions;
};

export type PublicNameClaimRequest = {
  quote: string;
  funding_tx_ref: string;
};

export type PublicNameRegistration = {
  id: string;
  label: string;
  label_normalized: string;
  status: "active" | "expired" | "revoked";
  owner_kind: "wallet";
  owner_wallet_address: string;
  chain_ref: string;
  price_paid_cents: number;
  currency: "USD";
  issued_at: number;
  expires_at: number | null;
  pirate_user_id: string | null;
};

export type PublicNameRegistrationResponse = {
  registration: PublicNameRegistration;
  quote: string;
  funding_tx_ref: string | null;
  settlement_tx_ref: string | null;
};

export type PublicNameStatus = ({
  label: string;
  label_normalized: string;
  status: "available";
} | {
  label: string;
  label_normalized: string;
  status: "registered";
  registration: PublicNameRegistration;
} | {
  label: string;
  label_normalized: string;
  status: "taken";
  owner_kind: "user";
});

export type CommunityRoleSummary = {
  user: string;
  display_name: string;
  handle: string;
  avatar_ref?: string | null;
  nationality_badge_country?: string | null;
  role: "owner" | "admin" | "moderator";
};

export type RedditVerification = {
  reddit_username: string;
  status: "pending" | "verified" | "failed" | "expired";
  verification_hint?: string | null;
  code_placement_surface?: "profile" | "bio" | "about" | null;
  last_checked_at?: number | null;
  failure_code?: "code_not_found" | "different_code_found" | "username_not_found" | "rate_limited" | "source_error" | null;
};

export type RedditImportSummary = {
  reddit_username: string;
  imported_at: number;
  account_age_days?: number | null;
  imported_reddit_score?: number | null;
  global_karma?: number | null;
  top_subreddits: Array<{
    subreddit: string;
    karma?: number | null;
    posts?: number | null;
    rank_source?: "karma" | "posts" | "source_order" | null;
  }>;
  moderator_of: Array<string>;
  inferred_interests: Array<string>;
  suggested_communities: Array<{
    community: string;
    name: string;
    reason: string;
  }>;
  coverage_note?: string | null;
};

export type OnboardingStatus = {
  generated_handle_assigned: boolean;
  cleanup_rename_available: boolean;
  onboarding_dismissed_at?: number | null;
  unique_human_verification_status: "not_started" | "pending" | "verified" | "expired" | "failed";
  namespace_verification_status: "not_started" | "pending" | "verified" | "stale" | "expired" | "disputed" | "failed";
  community_creation_ready: boolean;
  missing_requirements: Array<string>;
  reddit_verification_status: "not_started" | "pending" | "verified" | "failed";
  reddit_import_status: "not_started" | "queued" | "running" | "succeeded" | "failed";
  suggested_community_ids?: Array<string>;
};

export type WalletAttachmentSummary = {
  wallet_attachment: string;
  chain_namespace: string;
  wallet_address: string;
  is_primary: boolean;
};

export type VerificationSession = {
  id: string;
  object: "verification_session";
  user: string;
  provider: "self" | "very" | "zkpassport";
  provider_mode?: "qr_deeplink" | "widget" | "native_sdk" | "web_sdk" | null;
  wallet_attachment?: string | null;
  requested_capabilities: Array<RequestedVerificationCapability>;
  verification_requirements?: Array<VerificationRequirement>;
  verification_intent?: VerificationIntent | null;
  policy?: string | null;
  status: "pending" | "verified" | "failed" | "expired";
  launch?: VerificationSessionLaunch;
  callback_path?: string | null;
  nationality?: string | null;
  age_at_verification?: number | null;
  attestation?: string | null;
  proof_hash?: string | null;
  evidence_ref?: string | null;
  verified_at?: number | null;
  failure_reason?: string | null;
  created: number;
  expires_at: number;
};

export type VerificationSessionLaunch = {
  mode: "qr_deeplink" | "widget" | "native_sdk" | "web_sdk" | "none";
  self_app?: SelfVerificationLaunch;
  very_widget?: VeryWidgetLaunch;
  zkpassport?: ZkPassportVerificationLaunch;
};

export type VeryWidgetLaunch = {
  app_id: string;
  context: string;
  type_id: string;
  query: Record<string, unknown>;
  verify_url: string;
  session_binding?: VerySessionBinding;
};

export type VerySessionBinding = {
  uniqueness_domain: string;
  binding_value: string;
  binding_field?: "pseudonym" | "challenge" | null;
  challenge_expires_at: number;
};

export type RequestedVerificationCapability = "unique_human" | "age_over_18" | "minimum_age" | "nationality" | "gender";

export type VerificationRequirement = ({
  proof_type: "minimum_age";
  minimum_age?: number;
} | {
  proof_type: "nationality";
  required_values?: Array<string>;
});

export type VerificationIntent = "profile_verification" | "community_creation" | "community_join" | "post_create" | "comment_create" | "post_access_18_plus" | "commerce_pricing" | "qualifier_disclosure";

export type AgentOwnershipProvider = "self_agent_id" | "clawkey";

export type AgentOwnershipSessionKind = "register" | "refresh" | "transfer" | "deregister";

export type AgentOwnershipSessionStatus = "pending" | "awaiting_owner" | "proof_submitted" | "verified" | "failed" | "expired" | "cancelled";

export type UserAgentStatus = "pending" | "active" | "suspended" | "revoked" | "transferred" | "deregistered";

export type AgentHandleStatus = "active" | "redirect" | "retired";

export type AgentOwnershipState = "pending" | "verified" | "expired" | "revoked" | "transferred";

export type AgentChallenge = {
  device: string;
  public_key: string;
  message: string;
  signature: string;
  timestamp: number;
};

export type AgentActionProof = {
  nonce: string;
  signed_at: number;
  canonical_request_hash: string;
  signature: string;
};

export type SelfAgentOwnershipLaunch = {
  deep_link?: string | null;
  qr_ref?: string | null;
  session_token_ref?: string | null;
};

export type ClawkeyRegistrationLaunch = {
  session: string;
  registration_url: string;
  expires_at?: number | null;
};

export type AgentOwnershipSessionLaunch = {
  mode: "qr_deeplink" | "registration_url" | "none";
  self_agent?: SelfAgentOwnershipLaunch;
  clawkey_registration?: ClawkeyRegistrationLaunch;
};

export type StartAgentOwnershipSessionRequest = {
  session_kind: AgentOwnershipSessionKind;
  ownership_provider: AgentOwnershipProvider;
  agent?: string | null;
  display_name?: string | null;
  policy?: string | null;
  agent_challenge: AgentChallenge;
};

export type CompleteAgentOwnershipSessionRequest = {
  attestation?: string | null;
  proof_hash?: string | null;
  provider_payload_ref?: string | null;
};

export type AgentOwnershipPairing = {
  pairing_code: string;
  expires_at: number;
};

export type AgentOwnershipPairingClaimRequest = {
  pairing_code: string;
  agent_challenge: AgentChallenge;
};

export type AgentOwnershipPairingClaimResult = {
  agent_ownership_session: string;
  registration_url: string;
  connection_token: string;
};

export type ProviderAgentOwnershipCallbackRequest = {
  provider?: AgentOwnershipProvider;
  event_type?: string | null;
  attestation?: string | null;
  proof_hash?: string | null;
  payload?: (Record<string, unknown>) | null;
};

export type AgentOwnershipRecord = {
  id: string;
  object: "agent_ownership_record";
  agent: string;
  owner_user: string;
  ownership_provider: AgentOwnershipProvider;
  provider_subject?: string | null;
  device?: string | null;
  public_key?: string | null;
  ownership_state: AgentOwnershipState;
  source_session?: string | null;
  verified_at?: number | null;
  expires_at?: number | null;
  ended_at?: number | null;
  evidence_ref?: string | null;
  created: number;
};

export type AgentOwnershipSession = {
  id: string;
  object: "agent_ownership_session";
  session_kind: AgentOwnershipSessionKind;
  owner_user?: string | null;
  agent?: string | null;
  ownership_provider: AgentOwnershipProvider;
  status: AgentOwnershipSessionStatus;
  agent_challenge_ref?: string;
  provider_session_ref?: string | null;
  launch: AgentOwnershipSessionLaunch;
  callback_path?: string | null;
  resolved_agent_ownership_record?: string | null;
  created: number;
  expires_at: number;
};

export type AgentDelegatedCredentialIssueRequest = {
  current_ownership_record?: string | null;
};

export type AgentDelegatedCredentialRefreshRequest = {
  refresh_token: string;
};

export type AgentDelegatedCredential = {
  id: string;
  object: "agent_delegated_credential";
  agent: string;
  owner_user: string;
  current_ownership_record: string;
  token_type: "Bearer";
  access_token: string;
  refresh_token: string;
  issued_at: number;
  expires_at: number;
  refresh_expires_at?: number | null;
};

export type UserAgent = {
  id: string;
  object: "user_agent";
  owner_user: string;
  display_name: string;
  handle?: AgentHandle | null;
  status: UserAgentStatus;
  current_ownership_record?: string | null;
  current_ownership?: AgentOwnershipRecord | null;
  created: number;
};

export type UserAgentListResponse = {
  items: Array<UserAgent>;
  next_cursor: string | null;
};

export type AgentHandle = {
  id: string;
  object: "agent_handle";
  agent: string;
  label_normalized: string;
  label_display: string;
  status: AgentHandleStatus;
  redirect_target_agent_handle?: string | null;
  issued_at: number;
  replaced_at?: number | null;
  created: number;
};

export type UpdateAgentHandleRequest = {
  desired_label: string;
};

export type UpdateUserAgentRequest = {
  display_name?: string;
};

export type PublicAgentResolution = {
  is_canonical: boolean;
  requested_handle_label: string;
  resolved_handle_label: string;
  agent: {
    agent: string;
    display_name?: string | null;
    handle: AgentHandle;
    ownership_provider?: AgentOwnershipProvider | null;
    created: number;
  };
  owner: {
    user: string;
    display_name?: string | null;
    global_handle: GlobalHandle;
    primary_public_handle: LinkedHandle | null;
  };
};

export type NamespaceVerificationAssertions = {
  root_exists?: boolean | null;
  root_control_verified?: boolean | null;
  expiry_horizon_sufficient?: boolean | null;
  routing_enabled?: boolean | null;
  pirate_dns_authority_verified?: boolean | null;
  root_key_proof_verified?: boolean | null;
  fabric_publish_verified?: boolean | null;
  anchor_fresh_enough?: boolean | null;
  owner_signed_updates_verified?: boolean | null;
};

export type NamespaceVerificationCapabilities = {
  club_attach_allowed?: boolean | null;
  pirate_web_routing_allowed?: boolean | null;
  pirate_subdomain_issuance_allowed?: boolean | null;
  owner_signed_record_updates_allowed?: boolean | null;
  pirate_subspace_issuance_allowed?: boolean | null;
};

export type NamespaceVerificationSession = {
  id: string;
  object: "namespace_verification_session";
  namespace_verification?: string | null;
  user: string;
  family: "hns" | "spaces";
  submitted_root_label: string;
  normalized_root_label?: string | null;
  status: "draft" | "inspecting" | "dns_setup_required" | "challenge_required" | "challenge_pending" | "verifying" | "verified" | "failed" | "expired" | "disputed";
  challenge_kind?: "dns_txt" | "fabric_txt_publish" | null;
  challenge_host?: string | null;
  challenge_txt_value?: string | null;
  challenge_payload?: (Record<string, unknown>) | null;
  challenge_expires_at?: number | null;
  setup_nameservers?: Array<string> | null;
  assertions?: NamespaceVerificationAssertions | null;
  capabilities?: NamespaceVerificationCapabilities | null;
  control_class?: "single_holder_root" | "multisig_controlled_root" | "dao_controlled_root" | "burned_or_immutable_root" | null;
  operation_class?: "owner_managed_namespace" | "routing_only_namespace" | "pirate_delegated_namespace" | "owner_signed_updates_namespace" | null;
  observation_provider?: string | null;
  evidence_bundle_ref?: string | null;
  failure_reason?: string | null;
  accepted_at?: number | null;
  created: number;
  expires_at: number;
};

export type NamespaceVerification = {
  id: string;
  object: "namespace_verification";
  user: string;
  family: "hns" | "spaces";
  normalized_root_label: string;
  status: "verified" | "stale" | "expired" | "disputed";
  assertions: NamespaceVerificationAssertions;
  capabilities: NamespaceVerificationCapabilities;
  control_class?: "single_holder_root" | "multisig_controlled_root" | "dao_controlled_root" | "burned_or_immutable_root" | null;
  operation_class?: "owner_managed_namespace" | "routing_only_namespace" | "pirate_delegated_namespace" | "owner_signed_updates_namespace" | null;
  observation_provider?: string | null;
  evidence_bundle_ref?: string | null;
  accepted_at: number;
  created: number;
  expires_at: number;
};

export type SessionExchangeResponse = {
  access_token: string;
  user: User;
  profile: Profile;
  onboarding: OnboardingStatus;
  wallet_attachments: Array<WalletAttachmentSummary>;
};

export type Community = {
  id: string;
  object: "community";
  display_name: string;
  description?: string | null;
  avatar_ref?: string | null;
  banner_ref?: string | null;
  store_url?: string | null;
  store_label?: string | null;
  country_code?: string | null;
  namespace_verification?: string | null;
  route_slug?: string | null;
  pending_namespace_verification_session?: string | null;
  status: "draft" | "active" | "frozen" | "archived" | "deleted";
  provisioning_state: "requested" | "provisioning" | "active" | "rotation_required" | "error";
  artist_identity?: string | null;
  community_agent_user?: string | null;
  membership_mode: "open" | "request" | "gated";
  karaoke_enabled: boolean;
  allow_anonymous_identity: boolean;
  anonymous_identity_scope?: "community_stable" | "thread_stable" | "post_ephemeral" | null;
  human_verification_lane: HumanVerificationLane;
  human_verification_lane_origin: CommunityAgentResolutionOrigin;
  allowed_disclosed_qualifiers?: Array<string> | null;
  allow_qualifiers_on_anonymous_posts?: boolean | null;
  guest_comment_policy: "disallow" | "altcha_required";
  root_post_min_trust_tier?: "new" | "established" | "trusted" | "high_trust" | null;
  reply_min_trust_tier?: "new" | "established" | "trusted" | "high_trust" | null;
  anonymous_posting_min_trust_tier?: "new" | "established" | "trusted" | "high_trust" | null;
  root_post_quota_by_trust_tier?: RootPostQuotaByTrustTier | null;
  reply_quota_by_trust_tier?: ReplyQuotaByTrustTier | null;
  probation_window_days?: number | null;
  link_post_policy?: "allow" | "require_established" | null;
  default_age_gate_policy?: "none" | "18_plus";
  gate_policy?: GatePolicy | null;
  agent_posting_policy: "disallow" | "review" | "allow_with_disclosure" | "allow";
  agent_posting_scope: "replies_only" | "top_level_and_replies";
  agent_daily_post_cap?: number | null;
  agent_daily_reply_cap?: number | null;
  agent_min_owner_trust_tier?: "new" | "established" | "trusted" | "high_trust" | null;
  agent_owner_active_limit?: number | null;
  accepted_agent_ownership_providers: Array<AgentOwnershipProvider>;
  accepted_agent_ownership_providers_origin: CommunityAgentResolutionOrigin;
  civic_scale_tier?: "club" | "village" | "town" | "city" | "state";
  donation_policy_mode: "none" | "optional_creator_sidecar";
  donation_partner_status: "unconfigured" | "active" | "paused";
  donation_partner?: DonationPartnerSummary | null;
  money_policy: CommunityMoneyPolicy;
  content_authenticity_policy: CommunityContentAuthenticityPolicy;
  content_authenticity_detection_policy: CommunityContentAuthenticityDetectionPolicy;
  market_context_policy: CommunityMarketContextPolicy;
  source_policy: CommunitySourcePolicy;
  capture_edit_policy: CommunityCaptureEditPolicy;
  adult_content_policy: CommunityAdultContentPolicy;
  graphic_content_policy: CommunityGraphicContentPolicy;
  motion_media_policy: CommunityMotionMediaPolicy;
  language_policy: CommunityLanguagePolicy;
  civility_policy: CommunityCivilityPolicy;
  visual_policy_settings: CommunityVisualPolicySettings;
  openai_moderation_settings?: ({
    scan_titles?: boolean;
    scan_post_bodies?: boolean;
    scan_captions?: boolean;
    scan_link_preview_text?: boolean;
    scan_images?: boolean;
  }) | null;
  provenance_policy: CommunityProvenancePolicy;
  promotion_policy: CommunityPromotionPolicy;
  label_policy?: CommunityLabelPolicy | null;
  community_profile?: CommunityProfile | null;
  reference_links?: Array<CommunityReferenceLinkPublic> | null;
  community_stage?: "initial";
  member_count?: number | null;
  qualified_member_count?: number | null;
  stage_entered_at?: number | null;
  governance_mode: "centralized" | "multisig" | "majeur";
  governance_backend?: CommunityGovernanceBackend | null;
  gate_rules?: Array<GateRule> | null;
  created_by_user: string;
  created: number;
};

export type CommunityMoneyPolicy = {
  id: string;
  object: "community_money_policy";
  policy_origin: CommunityPolicyOrigin;
  funding_preference: string;
  accepted_funding_assets: Array<CommunityMoneyAssetRef>;
  accepted_source_chains: Array<CommunityMoneyChainRef>;
  approved_route_providers?: Array<string> | null;
  destination_settlement_chain: CommunityMoneyChainRef;
  destination_settlement_token: string;
  treasury_denomination?: string | null;
  max_slippage_bps: number;
  quote_ttl_seconds: number;
  route_required: boolean;
  route_status_policy: CommunityFundingRouteStatusPolicy;
  route_hop_tolerance: number;
};

export type CommunityPricingPolicy = {
  id: string;
  object: "community_pricing_policy";
  policy_origin: CommunityPolicyOrigin;
  pricing_policy_version: string;
  regional_pricing_enabled: boolean;
  verification_provider_requirement?: CommunityPricingVerificationProvider | null;
  default_tier_key?: string | null;
  tiers: Array<CommunityPricingTier>;
  country_assignments: Array<CommunityPricingCountryAssignment>;
  source_template?: string | null;
  source_template_version?: string | null;
};

export type CommunityListing = {
  id: string;
  object: "community_listing";
  community: string;
  asset?: string | null;
  live_room?: string | null;
  replay_asset?: string | null;
  listing_mode: "fixed_price";
  status: "draft" | "active" | "paused" | "archived";
  price_cents: number;
  regional_pricing_enabled: boolean;
  donation_partner?: string | null;
  donation_share_bps?: number | null;
  vinyl_release_provider?: "elasticstage" | null;
  vinyl_release_url?: string | null;
  created_by_user: string;
  created: number;
};

export type CreateCommunityListingRequest = {
  asset?: string | null;
  live_room?: string | null;
  replay_asset?: string | null;
  price_cents: number;
  regional_pricing_enabled: boolean;
  donation_partner?: string | null;
  donation_share_bps?: number | null;
  vinyl_release_provider?: "elasticstage" | null;
  vinyl_release_url?: string | null;
  status: "draft" | "active" | "paused" | "archived";
};

export type UpdateCommunityListingRequest = {
  price_cents?: number;
  regional_pricing_enabled?: boolean;
  donation_partner?: string | null;
  donation_share_bps?: number | null;
  status?: "draft" | "active" | "paused" | "archived";
};

export type CommunityListingListResponse = {
  items: Array<CommunityListing>;
  next_cursor: string | null;
};

export type CommunityPurchase = {
  id: string;
  object: "community_purchase";
  community: string;
  listing: string;
  asset?: string | null;
  live_room?: string | null;
  replay_asset?: string | null;
  buyer_user: string;
  settlement_wallet_attachment: string;
  purchase_price_cents: number;
  pricing_tier?: string | null;
  settlement_mode: CommunityPurchaseSettlementMode;
  settlement_chain: CommunityMoneyChainRef;
  settlement_token: string;
  settlement_tx_ref: string;
  allocations: Array<CommunitySaleAllocationLeg>;
  donation_partner?: string | null;
  donation_share_bps?: number | null;
  donation_amount_cents?: number | null;
  vinyl_release_provider?: "elasticstage" | null;
  vinyl_release_url?: string | null;
  purchase_entitlement: string;
  entitlement_kind: "asset_access" | "live_room_access" | "replay_access" | "license";
  entitlement_target_ref: string;
  created: number;
};

export type CommunityPurchaseListResponse = {
  items: Array<CommunityPurchase>;
  next_cursor: string | null;
};

export type CommunityPurchaseQuotePreflightRequest = {
  listing?: string | null;
  funding_asset?: CommunityMoneyAssetRef | null;
  source_chain?: CommunityMoneyChainRef | null;
  route_provider?: string | null;
  client_estimated_slippage_bps: number;
  client_estimated_hop_count: number;
  client_route_valid_for_seconds?: number | null;
};

export type CommunityPurchaseQuotePreflight = {
  community: string;
  eligible: boolean;
  funding_mode: CommunityPurchaseFundingMode;
  policy_origin: CommunityPolicyOrigin;
  funding_preference: string;
  funding_asset?: CommunityMoneyAssetRef | null;
  source_chain?: CommunityMoneyChainRef | null;
  route_provider?: string | null;
  destination_settlement_chain: CommunityMoneyChainRef;
  destination_settlement_token: string;
  treasury_denomination?: string | null;
  max_slippage_bps: number;
  quote_ttl_seconds: number;
  route_required: boolean;
  route_status_policy: CommunityFundingRouteStatusPolicy;
  route_hop_tolerance: number;
  base_price_cents?: number | null;
  viewer_price_cents?: number | null;
  best_verified_price_cents?: number | null;
  max_self_discount_bps?: number | null;
  verification_required_provider?: CommunityPricingVerificationProvider | null;
  quoted_at: number;
  expires_at: number;
};

export type CommunityPurchaseQuoteRequest = {
  listing: string;
  funding_asset?: CommunityMoneyAssetRef | null;
  source_chain?: CommunityMoneyChainRef | null;
  route_provider?: string | null;
  client_estimated_slippage_bps: number;
  client_estimated_hop_count: number;
  client_route_valid_for_seconds?: number | null;
};

export type CommunityPurchaseQuote = {
  id: string;
  object: "community_purchase_quote";
  community: string;
  listing: string;
  buyer_user: string;
  asset?: string | null;
  live_room?: string | null;
  replay_asset?: string | null;
  base_price_cents: number;
  pricing_tier?: string | null;
  final_price_cents: number;
  settlement_mode: CommunityPurchaseSettlementMode;
  allocation_snapshot: Array<CommunitySaleAllocationSnapshot>;
  funding_mode: CommunityPurchaseFundingMode;
  funding_asset?: CommunityMoneyAssetRef | null;
  source_chain?: CommunityMoneyChainRef | null;
  route_provider?: string | null;
  route_policy_compliant: boolean;
  route_live_available?: boolean | null;
  policy_origin: CommunityPolicyOrigin;
  destination_settlement_chain: CommunityMoneyChainRef;
  destination_settlement_token: string;
  destination_settlement_amount_atomic?: string | null;
  destination_settlement_decimals?: number | null;
  funding_destination_address?: string | null;
  treasury_denomination?: string | null;
  quote_ttl_seconds: number;
  route_required: boolean;
  route_status_policy: CommunityFundingRouteStatusPolicy;
  route_hop_tolerance: number;
  verification_snapshot_ref?: string | null;
  pricing_policy_version?: string | null;
  quoted_at: number;
  expires_at: number;
};

export type CommunityPurchaseSettlementRequest = {
  quote: string;
  settlement_wallet_attachment: string;
  funding_tx_ref: string;
  settlement_tx_ref: string;
};

export type CommunityPurchaseSettlement = {
  id: string;
  object: "community_purchase_settlement";
  quote: string;
  community: string;
  listing: string;
  buyer_user: string;
  asset?: string | null;
  live_room?: string | null;
  replay_asset?: string | null;
  settlement_wallet_attachment: string;
  purchase_price_cents: number;
  pricing_tier?: string | null;
  settlement_mode: CommunityPurchaseSettlementMode;
  settlement_chain: CommunityMoneyChainRef;
  settlement_chain_ref: string;
  settlement_token: string;
  settlement_tx_ref: string;
  allocations: Array<CommunitySaleAllocationLeg>;
  donation_partner?: string | null;
  donation_share_bps?: number | null;
  donation_amount_cents?: number | null;
  vinyl_release_provider?: "elasticstage" | null;
  vinyl_release_url?: string | null;
  entitlement_kind: "asset_access" | "live_room_access" | "replay_access";
  entitlement_target_ref: string;
  purchase_entitlement: string;
  settled_at: number;
};

export type CommunityPurchaseSettlementFailureRequest = {
  quote: string;
};

export type CommunityPurchaseSettlementFailure = {
  id: string;
  object: "community_purchase_settlement_failure";
  quote: string;
  community: string;
  status: "failed" | "expired";
  failed_at?: number | null;
  expires_at: number;
};

export type CreateLiveRoomRequest = {
  title: string;
  description?: string | null;
  event_start_at?: number | null;
  access_mode: "free" | "included_with_ticket" | "paid" | "gated" | "paid";
  room_kind: "solo" | "duet";
  visibility: "public" | "unlisted";
  guest_user?: string | null;
  performer_allocations: Array<LiveRoomPerformerAllocationInput>;
  cover_ref?: string | null;
  recording_enabled?: boolean | null;
  participant_capacity?: number | null;
  listing?: string | null;
  replay_listing?: string | null;
  anchor_post?: string | null;
  initial_setlist: InitialLiveSetlistInput;
};

export type LiveRoom = {
  id: string;
  object: "live_room";
  community: string;
  anchor_post: string;
  host_user: string;
  title: string;
  description?: string | null;
  status: "scheduled" | "live" | "ended" | "canceled";
  access_mode: "free" | "gated" | "paid";
  room_kind: "solo" | "duet";
  visibility: "public" | "unlisted";
  guest_user?: string | null;
  performer_allocations: Array<LiveRoomPerformerAllocationInput>;
  listing?: string | null;
  replay_listing?: string | null;
  broadcast_ref?: string | null;
  recording_enabled: boolean;
  event_start_at?: number | null;
  live_started_at?: number | null;
  ended_at?: number | null;
  canceled_at?: number | null;
  cover_ref?: string | null;
  participant_capacity?: number | null;
  replay_asset?: string | null;
  replay_status: "none" | "processing" | "review_pending" | "published" | "failed";
  created: number;
};

export type LiveRoomReplayDraft = {
  object: "live_room_replay_draft";
  live_room: string;
  recording_enabled: boolean;
  replay_status: "none" | "processing" | "review_pending" | "published" | "failed";
  status: LiveRoomReplayDraftStatus;
  replay_asset: LiveRoomReplayAsset | null;
  recording: LiveRoomReplayRecording | null;
};

export type LiveRoomReplayAsset = {
  id: string;
  object: "live_room_replay_asset";
  publication_status: "draft" | "published" | "failed";
  title: string;
  caption: string | null;
  duration_ms: number | null;
  preview_ref: string | null;
  access_mode: LiveRoomReplayAssetAccessMode;
  locked_delivery_status: "none" | "requested" | "ready" | "failed";
  published_at: string | null;
  allocations: Array<LiveRoomReplayAllocation>;
};

export type LiveRoomReplayAllocation = {
  id: string;
  participant_user: string | null;
  external_party_ref: string | null;
  role: string;
  share_bps: number;
  rights_basis: string;
  approval_status: "pending" | "approved" | "rejected";
};

export type LiveRoomReplayStoryCdrAccess = {
  chain_id: number;
  rpc_url: string;
  cdr_contract_address: string;
  read_condition_address: string;
  ciphertext_ref: string;
  cipher_algorithm: string;
  cipher_iv_b64: string;
  mime_type: string;
  vault_uuid: number;
  namespace: string;
  access_scope: "asset.owner" | "asset.share";
  access_ref: string;
  access_aux_data_hex?: string;
  access_proof: Record<string, unknown>;
};

export type LiveRoomReplayAccessResponse = {
  live_room: string;
  replay_asset: string | null;
  replay_listing: CommunityListing | null;
  replay_status: "none" | "processing" | "review_pending" | "published" | "failed";
  access_mode: LiveRoomReplayAssetAccessMode | null;
  locked_delivery_status: "none" | "requested" | "ready" | "failed" | null;
  access_granted: boolean;
  decision_reason: "free" | "creator" | "moderator" | "purchase_entitlement" | "purchase_required" | "delivery_pending" | "not_published" | "not_available";
  delivery_kind: "primary_content_ref" | "story_cdr_ref" | null;
  delivery_ref: string | null;
  story_cdr_access: LiveRoomReplayStoryCdrAccess | null;
};

export type UpdateLiveRoomReplayDraftRequest = {
  title?: string | null;
  caption?: string | null;
  preview_ref?: string | null;
  access_mode?: LiveRoomReplayAssetAccessMode | null;
  allocations?: Array<LiveRoomReplayDraftAllocationInput> | null;
};

export type PublishLiveRoomReplayDraftRequest = {
  access_mode?: "free" | "included_with_ticket" | "paid";
  listing?: CreateCommunityListingRequest | null;
};

export type CommunityHandle = {
  id: string;
  object: "community_handle";
  community: string;
  user: string;
  namespace: string;
  label: string;
  label_normalized: string;
  status: "active" | "grace_period" | "expired" | "revoked" | "reserved";
  issuance_source: "claim" | "auction" | "admin_grant";
  quote: string | null;
  price_cents: number;
  currency: "USD";
  pricing_model: "free" | "flat_by_length" | "custom_curve" | "gated_then_flat" | null;
  pricing_tier: string | null;
  settlement_wallet_attachment: string | null;
  protocol_owner_wallet_attachment: string | null;
  funding_tx_ref: string | null;
  settlement_tx_ref: string | null;
  lease_started_at: number | null;
  lease_expires_at: number | null;
  protocol_issuance?: CommunityHandleProtocolIssuance | null;
  created: number;
};

export type CommunityHandleProtocolIssuance = {
  status: string;
  sname: string;
  parent_space: string;
  issued_at: number | null;
};

export type CommunityHandleClaimRequest = {
  quote: string;
  settlement_wallet_attachment?: string | null;
  protocol_owner_wallet_attachment?: string | null;
  funding_tx_ref?: string | null;
  settlement_tx_ref?: string | null;
};

export type CommunityHandleListResponse = {
  handles: Array<CommunityHandle>;
};

export type CommunityHandleMeResponse = {
  handle: CommunityHandle | null;
};

export type CommunityHandleStatusResponse = {
  available: boolean;
  reason: string | null;
  claims_enabled: boolean | null;
  namespace: string | null;
};

export type CommunityHandlePolicy = {
  id: string;
  object: "community_handle_policy";
  community: string;
  namespace: string;
  policy_template: "standard" | "premium" | "membership_gated" | "custom";
  pricing_model: "free" | "flat_by_length" | "custom_curve" | "gated_then_flat" | null;
  claims_enabled: boolean;
  settings: CommunityHandlePolicySettings;
  updated_at: number | null;
};

export type CommunityHandlePolicySettings = {
  flat_price_cents?: number;
  premium_price_cents?: number;
  premium_max_length?: number;
  min_length?: number;
  max_length?: number;
  quote_ttl_seconds?: number;
  reserved_labels?: Array<string>;
  special_price_cents_by_label?: Record<string, number>;
  issuance_mode?: "app_internal" | "spaces_subspace";
};

export type CommunityHandlePaymentInstructions = {
  chain: {
    chain_namespace: string;
    chain_id: number;
    display_name: string;
  };
  token_address: string;
  recipient_address: string;
  amount_atomic: string;
  amount_display: string;
};

export type CommunityHandleQuote = {
  id: string;
  object: "community_handle_quote";
  community: string;
  namespace: string;
  desired_label: string;
  label: string;
  label_normalized: string;
  eligible: boolean;
  availability: "available" | "taken" | "reserved" | "already_claimed_by_viewer" | "viewer_has_claim" | "namespace_unavailable";
  reason: string | null;
  price_cents: number;
  currency: "USD";
  pricing_model: "free" | "flat_by_length" | "custom_curve" | "gated_then_flat" | null;
  pricing_tier: string | null;
  protocol_issuance_required: boolean;
  protocol_issuance_eligible: boolean;
  protocol_issuance_reason: string | null;
  payment_instructions: CommunityHandlePaymentInstructions | null;
  quote_ttl_seconds: number;
  quoted_at: number;
  expires_at: number;
};

export type CommunityHandleQuoteRequest = {
  desired_label: string;
};

export type CommunityHandleReserveRequest = {
  desired_label: string;
};

export type CommunityHandleRevokeRequest = {
  reason?: string | null;
};

export type UpdateCommunityHandlePolicyRequest = {
  policy_template?: "standard" | "premium" | "membership_gated" | "custom";
  pricing_model?: "free" | "flat_by_length" | "custom_curve" | "gated_then_flat";
  claims_enabled?: boolean;
  settings?: CommunityHandlePolicySettings | null;
};

export type MembershipResult = {
  community: string;
  status: "joined" | "requested" | "left";
};

export type CommunityFollowResponse = {
  community: string;
  following: boolean;
  follower_count?: number | null;
};

export type Job = {
  id: string;
  object: "job";
  job_type: "community_provisioning" | "reddit_snapshot_import" | "club_threads_export" | "media_analysis" | "story_publication" | "purchase_settlement_confirmation" | "entitlement_grant" | "artist_metadata_enrichment" | "track_reconciliation" | "catalog_track_preregistration" | "stem_separation" | "forced_alignment" | "karaoke_package_assembly";
  status: "queued" | "running" | "succeeded" | "failed";
  subject_type: string;
  subject: string;
  result_ref?: string | null;
  error_code?: string | null;
  created: number;
};

export type CommunityCreateAcceptedResponse = {
  community: Community;
  job: Job;
};

export type CreateCommunityRequest = (CreateCentralizedCommunityRequest | CreateMultisigCommunityRequest | CreateMajeurCommunityRequest);

export type GatePolicy = {
  version: 1;
  expression: GateExpression;
};

export type GateExpression = {
  op: "and" | "or" | "gate";
  children?: Array<Record<string, unknown>>;
  gate?: GateAtom;
};

export type GateAtom = {
  type: "unique_human" | "minimum_age" | "nationality" | "gender" | "wallet_score" | "altcha_pow" | "erc721_holding" | "erc721_inventory_match";
  provider?: "self" | "zkpassport" | "very" | "passport" | "courtyard" | "altcha" | null;
  accepted_providers?: Array<"self" | "zkpassport"> | null;
  minimum_age?: number;
  allowed?: Array<string>;
  minimum_score?: number;
  chain_namespace?: string;
  contract_address?: string;
  min_quantity?: number;
  match?: Record<string, unknown>;
};

export type UpdateCommunityMoneyPolicyRequest = {
  funding_preference?: string;
  accepted_funding_assets?: Array<CommunityMoneyAssetRef>;
  accepted_source_chains?: Array<CommunityMoneyChainRef>;
  approved_route_providers?: Array<string> | null;
  destination_settlement_chain?: CommunityMoneyChainRef;
  destination_settlement_token?: string;
  treasury_denomination?: string | null;
  max_slippage_bps?: number;
  quote_ttl_seconds?: number;
  route_required?: boolean;
  route_status_policy?: CommunityFundingRouteStatusPolicy;
  route_hop_tolerance?: number;
};

export type UpdateCommunityPricingPolicyRequest = {
  regional_pricing_enabled?: boolean;
  verification_provider_requirement?: CommunityPricingVerificationProvider | null;
  default_tier_key?: string | null;
  tiers?: Array<CommunityPricingTier>;
  country_assignments?: Array<CommunityPricingCountryAssignment>;
  source_template?: string | null;
  source_template_version?: string | null;
};

export type StartVerificationSessionRequest = {
  provider: "self" | "very" | "zkpassport";
  provider_mode?: "qr_deeplink" | "widget" | "native_sdk" | "web_sdk" | null;
  requested_capabilities?: Array<RequestedVerificationCapability>;
  verification_requirements?: Array<VerificationRequirement> | null;
  wallet_attachment?: string | null;
  verification_intent?: VerificationIntent | null;
  policy?: string | null;
};

export type CompleteVerificationSessionRequest = {
  attestation?: string | null;
  proof?: (string | Record<string, unknown> | Array<unknown>) | null;
  proof_hash?: string | null;
  provider_payload_ref?: (string | Record<string, unknown>) | null;
};

export type RefreshPassportWalletScoreRequest = {
  wallet_attachment?: string | null;
  community?: string | null;
};

export type RefreshPassportWalletScoreResponse = {
  wallet_score: WalletScoreCapabilityState;
  wallet_score_status?: ({
    current_score_decimal?: string | null;
    required_score_decimal?: string | null;
    passing_score?: boolean | null;
    last_scored_at?: number | null;
  }) | null;
  join_eligibility?: JoinEligibility | null;
};

export type StartNamespaceVerificationSessionRequest = {
  family: "hns" | "spaces";
  root_label: string;
};

export type CompleteNamespaceVerificationSessionRequest = {
  restart_challenge?: boolean | null;
};

export type CreateSongArtifactUploadRequest = {
  artifact_kind: "primary_audio" | "cover_art" | "preview_audio" | "preview_video" | "canvas_video" | "instrumental_audio" | "vocal_audio" | "primary_video";
  mime_type: string;
  filename?: string | null;
  size_bytes?: number | null;
  content_hash?: string | null;
  upload_mode?: "proxy" | "direct_multipart" | null;
};

export type CreateSongArtifactBundleRequest = {
  primary_audio: SongArtifactUploadRef;
  title: string;
  lyrics: string;
  genius_annotations_url?: string | null;
  cover_art?: SongArtifactUploadRef | null;
  preview_audio?: SongArtifactUploadRef | null;
  preview_window?: SongPreviewWindow | null;
  canvas_video?: SongArtifactUploadRef | null;
  instrumental_audio?: SongArtifactUploadRef | null;
  vocal_audio?: SongArtifactUploadRef | null;
};

export type CreatePostRequest = (unknown | {
  post_type: "image";
  title?: string | null;
  media_refs: Array<ImageMediaDescriptor>;
} | {
  post_type: "video";
  title?: string | null;
  access_mode?: "public" | "locked";
  license_preset?: "non-commercial" | "commercial-use" | "commercial-remix" | null;
  commercial_rev_share_pct?: number | null;
  media_refs: Array<VideoMediaDescriptor>;
} | {
  post_type: "link";
  title?: string | null;
  body?: string | null;
  link_url: string;
} | {
  post_type: "crosspost";
  title: string;
  source_post: string;
  source_community: string;
});

export type CreateCommentRequest = {
  idempotency_key?: string | null;
  body?: string;
  media_refs?: Array<MediaDescriptor>;
  authorship_mode?: "human_direct" | "user_agent" | "guest";
  agent?: string | null;
  agent_action_proof?: AgentActionProof | null;
  identity_mode?: "public" | "anonymous";
  anonymous_scope?: "community_stable" | "thread_stable" | null;
};

export type Asset = {
  id: string;
  object: "asset";
  community: string;
  source_post: string;
  song_artifact_bundle?: string | null;
  display_title?: string | null;
  creator_user: string;
  asset_kind: "song_audio" | "video_file";
  rights_basis: "none" | "original" | "derivative" | "attribution_only";
  access_mode: "public" | "locked";
  license_preset?: "non-commercial" | "commercial-use" | "commercial-remix" | null;
  commercial_rev_share_pct?: number | null;
  primary_content_ref: string;
  primary_content_hash?: string | null;
  publication_status: "draft" | "story_requested" | "story_published" | "story_failed" | "withdrawn";
  story_status: "none" | "requested" | "published" | "failed";
  story_error?: string | null;
  story_ip?: string | null;
  story_ip_nft_contract?: string | null;
  story_ip_nft_token?: string | null;
  story_publish_model?: "pirate_v1" | "story_ip_v1";
  story_license_terms?: string | null;
  story_license_template?: string | null;
  story_royalty_policy?: string | null;
  story_derivative_parent_ip_ids?: Array<string> | null;
  story_derivative_registered_at?: number | null;
  story_revenue_token?: string | null;
  story_royalty_registration_status?: "none" | "pending" | "registered" | "failed";
  story_publish_tx_ref?: string | null;
  story_asset_version?: string | null;
  story_cdr_vault_uuid?: number | null;
  story_namespace?: string | null;
  story_entitlement_token?: string | null;
  story_read_condition?: string | null;
  story_write_condition?: string | null;
  locked_delivery_status: "none" | "requested" | "ready" | "failed";
  locked_delivery_ref?: string | null;
  locked_delivery_error?: string | null;
  created: number;
};

export type AssetAccessResponse = {
  asset: string;
  community: string;
  source_post: string;
  access_mode: "public" | "locked";
  source_post_status: "draft" | "published" | "hidden";
  story_status: "none" | "requested" | "published" | "failed";
  locked_delivery_status: "none" | "requested" | "ready" | "failed";
  bundle_preview_status?: "pending" | "processing" | "completed" | "failed" | null;
  access_granted: boolean;
  decision_reason: "public" | "creator" | "moderator" | "purchase_entitlement" | "purchase_required" | "delivery_pending" | "preview_pending";
  delivery_kind: "primary_content_ref" | "locked_delivery_ref" | "story_cdr_ref" | null;
  delivery_ref: string | null;
  story_cdr_access?: ({
    chain_id: number;
    rpc_url: string;
    cdr_contract_address: string;
    read_condition_address: string;
    ciphertext_ref: string;
    cipher_algorithm: string;
    cipher_iv_b64: string;
    mime_type: string;
    vault_uuid: number;
    namespace: string;
    access_scope: "asset.owner" | "asset.share";
    access_ref: string;
    access_aux_data_hex?: string;
    access_proof: Record<string, unknown>;
  }) | null;
};

export type SongAudioArtifactDescriptor = {
  storage_ref: string;
  mime_type: string;
  size_bytes?: number | null;
  content_hash?: string | null;
  decentralized_storage?: (Record<string, unknown>) | null;
  duration_ms?: number | null;
  clip_start_ms?: number | null;
  clip_duration_ms?: number | null;
};

export type SongArtifactUpload = {
  id: string;
  object: "song_artifact_upload";
  community: string;
  uploader_user: string;
  artifact_kind: "primary_audio" | "cover_art" | "preview_audio" | "preview_video" | "canvas_video" | "instrumental_audio" | "vocal_audio" | "primary_video";
  status: "pending_upload" | "uploaded" | "failed" | "cancelled";
  storage_ref: string;
  mime_type: string;
  filename?: string | null;
  size_bytes?: number | null;
  content_hash?: string | null;
  storage_provider?: "filebase" | "local_dev_file_storage" | null;
  storage_bucket?: string | null;
  storage_object_key?: string | null;
  storage_endpoint?: string | null;
  gateway_url?: string | null;
  ipfs_cid?: string | null;
  upload_url: string;
  upload_session?: ({
    id: string;
    status: "created" | "parts_uploading" | "completing" | "head_verifying" | "uploaded" | "aborting" | "aborted";
    object_key: string;
    upload_id: string;
    part_size_bytes: number;
    total_parts: number;
    expires_at: string;
    sign_part_url: string;
    complete: string;
    abort: string;
  }) | null;
  created: number;
};

export type SongArtifactBundle = {
  id: string;
  object: "song_artifact_bundle";
  community: string;
  creator_user: string;
  status: "draft" | "validating" | "ready" | "consuming" | "consumed" | "failed";
  title: string;
  primary_audio: SongAudioArtifactDescriptor;
  media_refs: Array<MediaDescriptor>;
  lyrics: string;
  lyrics_sha256: string;
  genius_annotations_url?: string | null;
  cover_art?: SongImageArtifactDescriptor | null;
  preview_audio?: SongAudioArtifactDescriptor | null;
  preview_window?: SongPreviewWindow | null;
  preview_status: "pending" | "processing" | "completed" | "failed";
  preview_error?: string | null;
  canvas_video?: SongVideoArtifactDescriptor | null;
  instrumental_audio?: SongAudioArtifactDescriptor | null;
  vocal_audio?: SongAudioArtifactDescriptor | null;
  translation_status: "pending" | "processing" | "completed" | "failed";
  translation_error?: string | null;
  translated_lyrics_ref?: string | null;
  translated_lyrics?: (Record<string, unknown>) | null;
  alignment_status: "pending" | "processing" | "completed" | "failed";
  alignment_error?: string | null;
  timed_lyrics_ref?: string | null;
  timed_lyrics?: (Record<string, unknown>) | null;
  moderation_status: "pending" | "processing" | "completed" | "failed";
  moderation_error?: string | null;
  moderation_result_ref?: string | null;
  moderation_result?: (Record<string, unknown>) | null;
  created: number;
};

export type SongArtifactBundleListResponse = {
  items: Array<SongArtifactBundle>;
  next_cursor: string | null;
};

export type SongPreviewGeneratePayload = {
  song_artifact_bundle?: string | null;
  primary_audio_content_hash?: string | null;
  preview_window?: SongPreviewWindow | null;
};

export type CrosspostSourceStatus = "available" | "deleted" | "removed" | "unavailable";

export type CrosspostSource = {
  status: CrosspostSourceStatus;
  post: string;
  community: string;
  captured_at?: string | null;
  post_type?: "text" | "image" | "video" | "link" | "song" | null;
  title?: string | null;
  community_label?: string | null;
  community_route_slug?: string | null;
  author_user?: string | null;
  author_label?: string | null;
  thumbnail_ref?: string | null;
};

export type PostDerivativeSource = {
  source_ref: string;
  title: string;
  kind: "song" | "video";
  relationship_type: "remix_of" | "references_song" | "references_video" | "inspired_by" | "samples";
  community?: string | null;
  asset?: string | null;
  source_post?: string | null;
  story_ip?: string | null;
  story_license_terms?: string | null;
  license_preset?: "non-commercial" | "commercial-use" | "commercial-remix" | null;
  commercial_rev_share_pct?: number | null;
  creator_user?: string | null;
  creator_handle?: string | null;
  creator_display_name?: string | null;
};

export type Post = {
  id: string;
  object: "post";
  community: string;
  author_user?: string | null;
  authorship_mode: "human_direct" | "user_agent";
  agent?: string | null;
  agent_ownership_record?: string | null;
  identity_mode: "public" | "anonymous";
  anonymous_scope?: "community_stable" | "thread_stable" | "post_ephemeral" | null;
  anonymous_label?: string | null;
  agent_handle_snapshot?: string | null;
  agent_display_name_snapshot?: string | null;
  agent_owner_handle_snapshot?: string | null;
  agent_ownership_provider_snapshot?: string | null;
  disclosed_qualifiers_json?: Array<DisclosedQualifierSnapshot> | null;
  label?: string | null;
  post_type: "text" | "image" | "video" | "link" | "song" | "crosspost";
  status: "draft" | "published" | "hidden" | "removed" | "deleted";
  comments_locked?: boolean;
  comments_locked_at?: number | null;
  comments_locked_by_user?: string | null;
  comments_lock_reason?: string | null;
  visibility: "public" | "members_only";
  title?: string | null;
  body?: string | null;
  caption?: string | null;
  link_url?: string | null;
  link_og_image_url?: string | null;
  link_og_title?: string | null;
  link_enrichment?: (Record<string, unknown>) | null;
  embeds?: Array<PostEmbed> | null;
  media_refs?: Array<MediaDescriptor>;
  creator_relation?: PostCreatorRelation | null;
  promotion_disclosure?: PromotionDisclosure | null;
  source_language?: string | null;
  source_language_confidence?: number | null;
  source_language_reliable?: boolean;
  source_language_detector?: string | null;
  source_language_detected_at?: string | null;
  source_language_source_hash?: string | null;
  translation_policy?: "none" | "machine_allowed" | "human_only" | "hybrid" | null;
  access_mode?: "public" | "locked" | null;
  asset?: string | null;
  song_artifact_bundle?: string | null;
  crosspost_source?: CrosspostSource | null;
  anchor_live_room?: string | null;
  anchor_live_room_status?: "scheduled" | "live" | "ended" | "canceled" | null;
  song_title?: string | null;
  song_annotations_url?: string | null;
  parent_post?: string | null;
  song_mode?: "original" | "remix" | null;
  rights_basis?: "none" | "original" | "derivative" | "attribution_only" | null;
  upstream_asset_refs?: Array<string> | null;
  analysis_state: "pending" | "allow" | "allow_with_required_reference" | "review_required" | "blocked";
  analysis_result_ref?: string | null;
  content_safety_state: "pending" | "safe" | "sensitive" | "adult";
  age_gate_policy: "none" | "18_plus";
  created: number;
};

export type DeletedPostResponse = {
  id: string;
  object: "post";
  deleted: true;
};

export type Comment = {
  id: string;
  object: "comment";
  community: string;
  thread_root_post: string;
  parent_comment: string | null;
  author_user: string | null;
  authorship_mode: "human_direct" | "user_agent" | "guest";
  agent?: string | null;
  agent_ownership_record?: string | null;
  identity_mode: "public" | "anonymous";
  anonymous_scope: "community_stable" | "thread_stable" | null;
  anonymous_label: string | null;
  agent_handle_snapshot?: string | null;
  agent_display_name_snapshot?: string | null;
  agent_owner_handle_snapshot?: string | null;
  agent_ownership_provider_snapshot?: AgentOwnershipProvider | null;
  body: string | null;
  media_refs?: Array<MediaDescriptor>;
  source_language?: string | null;
  source_language_confidence?: number | null;
  source_language_reliable?: boolean;
  source_language_detector?: string | null;
  source_language_detected_at?: string | null;
  source_language_source_hash?: string | null;
  status: "published" | "hidden" | "removed" | "deleted";
  replies_locked?: boolean;
  replies_locked_at?: number | null;
  replies_locked_by_user?: string | null;
  replies_lock_reason?: string | null;
  depth: number;
  direct_reply_count: number;
  descendant_count: number;
  upvote_count: number;
  downvote_count: number;
  score: number;
  last_reply_at: number | null;
  content_hash: string | null;
  swarm_body_ref: string | null;
  idempotency_key: string | null;
  created: number;
};

export type CommentListItem = {
  id: string;
  object: "comment_list_item";
  comment: Comment;
  viewer_vote: -1 | 1 | null;
  viewer_can_delete?: boolean;
  resolved_locale: string;
  translation_state: "ready" | "pending" | "same_language" | "policy_blocked";
  machine_translated: boolean;
  translated_body?: string | null;
  source_hash: string;
};

export type CommentThreadSnapshot = {
  thread_root_post: string;
  snapshot_seq: number;
  published_through_comment_created: number;
  comment_count: number;
  swarm_manifest_ref: string;
  swarm_feed_ref: string | null;
  created: number;
};

export type CommentListResponse = {
  items: Array<CommentListItem>;
  next_cursor: string | null;
  thread_snapshot: CommentThreadSnapshot | null;
};

export type CommentContext = {
  ancestors: Array<CommentListItem>;
  comment: CommentListItem;
  replies: Array<CommentListItem>;
  next_replies_cursor: string | null;
  thread_snapshot: CommentThreadSnapshot | null;
};

export type PostVoteResponse = {
  post: string;
  value: -1 | 1;
};

export type CommentVoteResponse = {
  comment: string;
  value: -1 | 1;
};

export type ModerationSignalSeverity = "low" | "medium" | "high";

export type UserReportReasonCode = "spam" | "harassment" | "hate" | "sexual_content" | "graphic_content" | "misleading" | "other";

export type ModerationActionType = "dismiss" | "hide" | "remove" | "restore" | "age_gate";

export type CreateUserReportRequest = {
  reason_code: UserReportReasonCode;
  note?: string | null;
};

export type UserReport = {
  id: string;
  object: "user_report";
  community: string;
  post: string | null;
  comment: string | null;
  reporter_user: string;
  reason_code: UserReportReasonCode;
  note?: string | null;
  created: number;
};

export type ModerationSignal = {
  id: string;
  object: "moderation_signal";
  community: string;
  post: string | null;
  comment: string | null;
  analysis_result_ref: string | null;
  source: "platform_analysis";
  signal_type: string;
  severity: ModerationSignalSeverity;
  provider: string;
  provider_label: string;
  evidence_ref?: string | null;
  created: number;
};

export type ModerationAction = {
  id: string;
  object: "moderation_action";
  moderation_case: string;
  community: string;
  post: string | null;
  comment: string | null;
  actor_user: string;
  action_type: ModerationActionType;
  note?: string | null;
  created: number;
};

export type ModerationCase = {
  id: string;
  object: "moderation_case";
  community: string;
  post: string | null;
  comment: string | null;
  status: ModerationCaseStatus;
  queue_scope: ModerationQueueScope;
  priority: ModerationSignalSeverity;
  opened_by: ModerationCaseOpenedBy;
  created: number;
  resolved_at?: number | null;
};

export type ModerationCasePostPreview = {
  post_id: string;
  post_type: string;
  status: string;
  title: string | null;
  body: string | null;
  caption: string | null;
  media_refs_json: string | null;
  author_handle: string | null;
};

export type ModerationCaseListItem = (ModerationCase & {
  post: ModerationCasePostPreview | null;
});

export type ModerationCaseDetail = {
  case: ModerationCase;
  post: Post | null;
  comment: Comment | null;
  signals: Array<ModerationSignal>;
  reports: Array<UserReport>;
  actions: Array<ModerationAction>;
};

export type ModerationCaseListResponse = {
  items: Array<ModerationCaseListItem>;
  next_cursor: string | null;
};

export type CreateModerationActionRequest = {
  action_type: ModerationActionType;
  note?: string | null;
};

export type SongPresentation = {
  title: string | null;
  cover_art_ref: string | null;
  duration_ms: number | null;
  downloadable_audio?: Array<{
    kind: "original" | "instrumental" | "vocals" | "preview";
    storage_ref: string;
    mime_type: string;
    size_bytes?: number | null;
    duration_ms?: number | null;
    filename?: string | null;
    decentralized_storage?: (Record<string, unknown>) | null;
  }> | null;
  alignment_status?: "pending" | "processing" | "completed" | "failed" | null;
  timed_lyrics_ref?: string | null;
  timed_lyrics?: (Record<string, unknown>) | null;
};

export type SongKaraokePayload = {
  id: string;
  object: "song_karaoke_payload";
  song?: string | null;
  post?: string | null;
  community?: string | null;
  title?: string | null;
  artist_name?: string | null;
  artwork_src?: string | null;
  instrumental_audio_url?: string | null;
  karaoke_lines?: Array<{
    id: string;
    index: number;
    kind: "lyric" | "section";
    text: string;
    start_ms: number;
    end_ms: number;
    words: Array<{
      text: string;
      start_ms: number;
      end_ms: number;
      confidence?: number | null;
    }>;
  }> | null;
  raw_lines?: Array<Record<string, unknown>> | null;
};

export type KaraokeScoringPolicy = ({
  kind: "disabled";
} | {
  kind: "enabled";
  provider: "assistant" | "elevenlabs" | "mistral" | "openai";
  model: string;
  retention: "not_stored";
  voice_coach_enabled?: boolean;
});

export type KaraokeSession = {
  id: string;
  object: "karaoke_session";
  attempt: string;
  protocol_version: 1;
  websocket_url: string;
  token_expires_at: number;
  session_expires_at: number;
  scoring_policy: KaraokeScoringPolicy;
};

export type LocalizedPostResponse = {
  post: Post;
  community?: CommunityPreview | null;
  author_community_role?: "owner" | "moderator" | null;
  thread_snapshot: CommentThreadSnapshot | null;
  market_context?: MarketContextSummary | null;
  label?: PostLabel | null;
  song_presentation?: SongPresentation | null;
  viewer_gate_state?: (Record<string, unknown>) | null;
  asset_story?: ({
    story_ip?: string | null;
    story_royalty_registration_status?: "none" | "pending" | "registered" | "failed";
  }) | null;
  derivative_sources?: Array<PostDerivativeSource> | null;
  upvote_count: number;
  downvote_count: number;
  like_count: number;
  comment_count?: number;
  viewer_vote: -1 | 1 | null;
  viewer_is_author?: boolean;
  age_gate_viewer_state?: "proof_required" | "verified_allowed" | null;
  viewer_reaction_kinds: Array<"like">;
  resolved_locale: string;
  translation_state: "ready" | "pending" | "same_language" | "policy_blocked";
  machine_translated: boolean;
  translated_body?: string | null;
  translated_title?: string | null;
  translated_caption?: string | null;
  translated_embeds?: Array<LocalizedPostEmbedTranslation> | null;
  source_hash: string;
};

export type LocalizedPostEmbedTranslation = {
  embed_key: string;
  translated_question?: string | null;
  translated_title?: string | null;
  translated_outcomes?: Array<{
    label: string;
    translated_label: string | null;
    source_hash: string;
  }> | null;
  source_hash: string;
};

export type MembershipGateSummary = {
  gate_type: "nationality" | "gender" | "unique_human" | "age_over_18" | "minimum_age" | "wallet_score" | "altcha_pow" | "erc721_holding" | "erc721_inventory_match";
  accepted_providers?: Array<"self" | "zkpassport" | "very" | "passport"> | null;
  required_value?: string | null;
  required_values?: Array<string> | null;
  excluded_values?: Array<string> | null;
  required_minimum_age?: number | null;
  minimum_score?: number | null;
  chain_namespace?: string | null;
  contract_address?: string | null;
  inventory_provider?: "courtyard" | null;
  min_quantity?: number | null;
  asset_filter_label?: string | null;
  asset_category?: string | null;
};

export type CommunityPreview = {
  id: string;
  object: "community_preview";
  namespace_verification?: string | null;
  route_slug?: string | null;
  display_name: string;
  description?: string | null;
  localized_text?: CommunityTextLocalization | null;
  avatar_ref?: string | null;
  banner_ref?: string | null;
  store_url?: string | null;
  store_label?: string | null;
  country_code?: string | null;
  membership_mode: "open" | "request" | "gated";
  karaoke_enabled: boolean;
  allow_anonymous_identity?: boolean;
  anonymous_identity_scope?: "community_stable" | "thread_stable" | "post_ephemeral" | null;
  allowed_disclosed_qualifiers?: Array<string> | null;
  allow_qualifiers_on_anonymous_posts?: boolean | null;
  guest_comment_policy?: "disallow" | "altcha_required";
  agent_posting_policy?: "disallow" | "review" | "allow_with_disclosure" | "allow";
  agent_posting_scope?: "replies_only" | "top_level_and_replies";
  agent_daily_post_cap?: number | null;
  agent_daily_reply_cap?: number | null;
  accepted_agent_ownership_providers?: Array<AgentOwnershipProvider>;
  human_verification_lane: HumanVerificationLane;
  member_count?: number | null;
  follower_count?: number | null;
  donation_policy_mode?: "none" | "optional_creator_sidecar" | null;
  donation_partner?: DonationPartnerSummary | null;
  owner?: CommunityRoleSummary | null;
  moderators: Array<CommunityRoleSummary>;
  reference_links?: Array<CommunityReferenceLinkPublic> | null;
  membership_gate_summaries: Array<MembershipGateSummary>;
  gate_match_mode?: "all" | "any" | null;
  rules: Array<CommunityRule>;
  viewer_membership_status?: "member" | "not_member" | "banned" | null;
  viewer_community_role?: "owner" | "admin" | "moderator" | null;
  viewer_following?: boolean | null;
  created: number;
};

export type JoinEligibility = {
  community: string;
  membership_mode: "open" | "request" | "gated";
  human_verification_lane: HumanVerificationLane;
  joinable_now: boolean;
  status: "joinable" | "requestable" | "pending_request" | "verification_required" | "gate_failed" | "already_joined" | "banned";
  membership_gate_summaries: Array<MembershipGateSummary>;
  missing_capabilities?: Array<"unique_human" | "age_over_18" | "minimum_age" | "nationality" | "gender" | "wallet_score" | "altcha_pow">;
  suggested_verification_provider?: "self" | "zkpassport" | "very" | "passport" | null;
  suggested_verification_intent?: "community_join" | "post_create" | "comment_create" | null;
  failure_reason?: "missing_verification" | "provider_not_accepted" | "nationality_mismatch" | "gender_mismatch" | "minimum_age_mismatch" | "erc721_holding_required" | "erc721_inventory_match_required" | "token_inventory_unavailable" | "wallet_score_too_low" | "unsupported" | "banned" | null;
  wallet_score_status?: ({
    current_score_decimal?: string | null;
    required_score_decimal?: string | null;
    passing_score?: boolean | null;
    last_scored_at?: number | null;
  }) | null;
  gate_evaluation?: GatePolicyEvaluation | null;
};

export type MembershipRequestStatus = "pending" | "approved" | "rejected" | "expired";

export type MembershipRequestSummary = {
  id: string;
  object: "membership_request_summary";
  community: string;
  applicant_user: string;
  applicant_handle?: string | null;
  applicant_avatar_ref?: string | null;
  status: MembershipRequestStatus;
  note?: string | null;
  created: number;
};

export type MembershipRequestListResponse = {
  items: Array<MembershipRequestSummary>;
  next_cursor: string | null;
};

export type GateFailureDetails = {
  human_verification_lane?: HumanVerificationLane;
  membership_gate_summaries?: Array<MembershipGateSummary> | null;
  missing_capabilities?: Array<string> | null;
  suggested_verification_provider?: "self" | "zkpassport" | "very" | "passport" | null;
  suggested_verification_intent?: "community_join" | "post_create" | "comment_create" | null;
  failure_reason?: "missing_verification" | "provider_not_accepted" | "nationality_mismatch" | "gender_mismatch" | "minimum_age_mismatch" | "erc721_holding_required" | "erc721_inventory_match_required" | "token_inventory_unavailable" | "wallet_score_too_low" | "unsupported" | "banned" | null;
  wallet_score_status?: ({
    current_score_decimal?: string | null;
    required_score_decimal?: string | null;
    passing_score?: boolean | null;
    last_scored_at?: number | null;
  }) | null;
  gate_evaluation?: GatePolicyEvaluation | null;
};

export type HomeFeedCommunitySummary = {
  id: string;
  object: "home_feed_community_summary";
  display_name: string;
  route_slug?: string | null;
  avatar_ref?: string | null;
  member_count?: number | null;
  follower_count?: number | null;
  view_count?: number | null;
};

export type HomeFeedItem = {
  community: HomeFeedCommunitySummary;
  post: LocalizedPostResponse;
};

export type HomeFeedResponse = {
  items: Array<FeedItem>;
  top_communities: Array<HomeFeedCommunitySummary>;
  next_cursor?: string | null;
};

export type HomeFeedSort = "best" | "top" | "new";

export type LinkedHandle = {
  linked_handle: string;
  label: string;
  kind: "pirate" | "ens";
  verification_state: "verified" | "unverified" | "stale";
  metadata?: (Record<string, unknown>) | null;
};

export type SelfVerificationDisclosures = {
  issuing_state?: boolean | null;
  name?: boolean | null;
  passport_number?: boolean | null;
  nationality?: boolean | null;
  date_of_birth?: boolean | null;
  gender?: boolean | null;
  expiry_date?: boolean | null;
  excluded_countries?: Array<string> | null;
  minimum_age?: number | null;
};

export type SelfVerificationLaunch = {
  app_name: string;
  logo_base64?: string | null;
  header?: string | null;
  endpoint: string;
  endpoint_type: "https" | "staging_https" | "celo" | "staging_celo";
  scope: string;
  session_id: string;
  user_id: string;
  user_id_type: "uuid" | "hex";
  disclosures: SelfVerificationDisclosures;
  deeplink_callback?: string | null;
  version?: 1 | 2 | null;
  user_defined_data?: string | null;
  chain_id?: number | null;
  dev_mode?: boolean | null;
};

export type UserTaskType = "namespace_verification_required" | "namespace_verification_pending" | "unique_human_verification_required" | "profile_completion_suggested" | "global_handle_cleanup_suggested" | "payout_setup_required" | "royalty_claim_available" | "membership_review";

export type UserTaskStatus = "open" | "completed" | "dismissed";

export type NotificationEventType = "comment_reply" | "post_commented" | "mention" | "mod_event" | "community_update" | "xmtp_message" | "royalty_earned";

export type UserTask = {
  id: string;
  object: "user_task";
  user: string;
  type: UserTaskType;
  subject_type: string;
  subject: string;
  status: UserTaskStatus;
  priority: number;
  payload: (Record<string, unknown>) | null;
  resolved_at?: number | null;
  dismissed_at?: number | null;
  created: number;
};

export type NotificationEvent = {
  id: string;
  object: "notification_event";
  type: NotificationEventType;
  actor_user: string | null;
  subject_type: string;
  subject: string;
  object_type?: string | null;
  payload?: (Record<string, unknown>) | null;
  created: number;
};

export type NotificationReceipt = {
  id: string;
  object: "notification_receipt";
  recipient_user: string;
  seen_at?: number | null;
  read_at?: number | null;
  created: number;
};

export type NotificationSummary = {
  open_task_count: number;
  unread_activity_count: number;
  has_unread: boolean;
};

export type NotificationFeedItem = {
  event: NotificationEvent;
  receipt: NotificationReceipt;
};

export type NotificationFeedResponse = {
  items: Array<NotificationFeedItem>;
  next_cursor: string | null;
};

export type NotificationTasksResponse = {
  items: Array<UserTask>;
  next_cursor: string | null;
};

export type MarkNotificationsReadRequest = {
  event_ids?: Array<string>;
};

export type DismissTaskRequest = {
  task_id: string;
};

export type ClaimableRoyaltyItem = {
  ip: string;
  claimable_wip_wei: string;
  asset: string;
  community: string;
  title: string | null;
};

export type ClaimableRoyaltiesResponse = {
  items: Array<ClaimableRoyaltyItem>;
  total_claimable_wip_wei: string;
  checked_at: number;
};

export type RoyaltyActivityItem = {
  id: string;
  object: "royalty_activity_item";
  community: string;
  asset: string;
  title: string | null;
  story_ip: string;
  amount_wip_wei: string;
  buyer_wallet_address: string | null;
  tx_hash: string | null;
  purchase: string | null;
  created: number;
  read_at: number | null;
};

export type RoyaltyActivityResponse = {
  items: Array<RoyaltyActivityItem>;
  next_cursor: string | null;
};

export type RoyaltyClaimRecordRequest = {
  tx_hash: string;
  wallet_address: string;
  chain: number;
  claimable_wip_wei_at_submission: string;
  ip_ids: Array<string>;
  auto_unwrap_ip_tokens: boolean;
};

export type RoyaltyClaimRecord = {
  id: string;
  object: "royalty_claim_record";
  user: string;
  tx_hash: string;
  wallet_address: string;
  chain: number;
  claimable_wip_wei_at_submission: string;
  ip_ids: Array<string>;
  auto_unwrap_ip_tokens: boolean;
  status: "pending" | "confirmed" | "failed";
  verified_at: number | null;
  verification_error: string | null;
  claimed_at: number;
  created: number;
};

export type RoyaltyClaimHistoryResponse = {
  items: Array<RoyaltyClaimRecord>;
};

type CentralizedGovernanceBackend = {
  governance_mode: "centralized";
  governance_verification_state: GovernanceVerificationState;
  governance_display_label?: string | null;
};

type CommunityAdultContentPolicy = {
  community: string;
  policy_origin: CommunityPolicyOrigin;
  suggestive: CommunityModerationDecisionLevel;
  artistic_nudity: CommunityModerationDecisionLevel;
  explicit_nudity: CommunityModerationDecisionLevel;
  explicit_sexual_content: CommunityModerationDecisionLevel;
  fetish_content: CommunityModerationDecisionLevel;
};

type CommunityAgentResolutionOrigin = "derived" | "explicit";

type CommunityAuthenticityDetectionProfileStatus = "active" | "archived";

type CommunityAuthenticityDetectionProfileSummary = {
  authenticity_detection_profile: string;
  profile_key: string;
  provider_key: string;
  supported_capabilities: Array<"image_authenticity" | "video_authenticity" | "audio_authenticity" | "deepfake_detection">;
  status: CommunityAuthenticityDetectionProfileStatus;
};

type CommunityCaptureEditPolicy = {
  community: string;
  policy_origin: CommunityPolicyOrigin;
  basic_adjustments: CommunityDisclosureDecisionLevel;
  retouching: CommunityDisclosureDecisionLevel;
  compositing: CommunityDisclosureDecisionLevel;
  documentary_editing: CommunityDisclosureDecisionLevel;
  require_edit_disclosure: boolean;
};

type CommunityCivilityPolicy = {
  community: string;
  policy_origin: CommunityPolicyOrigin;
  group_directed_demeaning_language: CommunityModerationDecisionLevel;
  targeted_insults: CommunityModerationDecisionLevel;
  targeted_harassment: CommunityModerationDecisionLevel;
  threatening_language: CommunityEscalationDecisionLevel;
};

type CommunityContentAuthenticityDetectionPolicy = {
  community: string;
  policy_origin: CommunityPolicyOrigin;
  selection_mode: CommunityContentAuthenticityDetectionSelectionMode;
  resolved_profile: CommunityAuthenticityDetectionProfileSummary;
};

type CommunityContentAuthenticityDetectionSelectionMode = "platform_default" | "approved_profile";

type CommunityContentAuthenticityPolicy = {
  community: string;
  policy_origin: CommunityPolicyOrigin;
  authenticity_stance: CommunityContentAuthenticityStance;
  text_policy: CommunityTextAuthenticityPolicySettings;
  image_policy: CommunityImageAuthenticityPolicySettings;
  video_policy: CommunityVideoAuthenticityPolicySettings;
  song_policy: CommunitySongAuthenticityPolicySettings;
};

type CommunityContentAuthenticityStance = "human_only" | "human_first" | "ai_allowed_with_disclosure" | "ai_allowed";

type CommunityCreatorRelation = "captured" | "created" | "subject" | "authorized_repost" | "fan_work" | "found";

type CommunityDisclosureDecisionLevel = "allow" | "require_disclosure" | "disallow";

type CommunityEscalationDecisionLevel = "review" | "disallow";

type CommunityFalseClaimConsequence = "warning" | "post_removed" | "temporary_ban" | "permanent_ban";

type CommunityFundingRouteStatusPolicy = "fail" | "fallback_display" | "queue";

type CommunityGovernanceBackend = (CentralizedGovernanceBackend | MultisigGovernanceBackend | MajeurGovernanceBackend);

type CommunityGraphicContentPolicy = {
  community: string;
  policy_origin: CommunityPolicyOrigin;
  injury_medical: CommunityModerationDecisionLevel;
  gore: CommunityModerationDecisionLevel;
  extreme_gore: CommunityModerationDecisionLevel;
  body_horror_disturbing: CommunityModerationDecisionLevel;
  animal_harm: CommunityModerationDecisionLevel;
};

type CommunityIdentifiedPersonMediaScope = "subject_only" | "subject_or_authorized" | "public_source_allowed";

type CommunityImageAuthenticityPolicySettings = {
  allow_ai_upscale: boolean;
  allow_ai_restoration: boolean;
  allow_generative_editing: boolean;
  allow_ai_generated: boolean;
};

type CommunityLabelDefinition = {
  id: string;
  object: "community_label_definition";
  label: string;
  description?: string | null;
  color_token?: string | null;
  status: "active" | "archived";
  position: number;
  allowed_post_types?: Array<"text" | "image" | "video" | "song"> | null;
};

type CommunityLabelPolicy = {
  label_enabled: boolean;
  require_label_on_top_level_posts: boolean;
  definitions: Array<CommunityLabelDefinition>;
};

type CommunityLanguagePolicy = {
  community: string;
  policy_origin: CommunityPolicyOrigin;
  profanity: CommunityModerationDecisionLevel;
  slurs: CommunityModerationDecisionLevel;
};

type CommunityMarketContextMode = "off" | "on";

type CommunityMarketContextPolicy = {
  id: string;
  object: "community_market_context_policy";
  policy_origin: CommunityPolicyOrigin;
  mode: CommunityMarketContextMode;
  enabled_post_types: Array<"link" | "image" | "video">;
  max_markets_per_post: number;
  provider_set: CommunityMarketContextProviderSet;
  resolved_profile: MarketContextProfileSummary;
};

type CommunityMarketContextProviderSet = "platform_default" | "approved_profile";

type CommunityModerationDecisionLevel = "allow" | "review" | "disallow";

type CommunityMoneyAssetRef = {
  asset_symbol: string;
  chain_namespace?: string | null;
  chain_id?: number | null;
  display_name?: string | null;
};

type CommunityMoneyChainRef = {
  chain_namespace: string;
  chain_id?: number | null;
  display_name?: string | null;
};

type CommunityMotionMediaPolicy = {
  community: string;
  policy_origin: CommunityPolicyOrigin;
  allow_animated_images: boolean;
  allow_silent_looping_video: boolean;
  allow_audio_video: boolean;
  max_video_duration_seconds?: number | null;
  require_video_transcription: boolean;
};

type CommunityPolicyOrigin = "default" | "explicit";

type CommunityPricingAdjustmentType = "multiplier";

type CommunityPricingCountryAssignment = {
  country_code: string;
  tier_key: string;
};

type CommunityPricingTier = {
  tier_key: string;
  display_name?: string | null;
  adjustment_type: CommunityPricingAdjustmentType;
  adjustment_value: number;
};

type CommunityPricingVerificationProvider = "self";

type CommunityProfile = {
  rules: Array<CommunityRule>;
  resource_links: Array<CommunityResourceLink>;
};

type CommunityPromotionPolicy = {
  community: string;
  policy_origin: CommunityPolicyOrigin;
  self_promotion_mode: CommunitySelfPromotionMode;
  require_affiliation_disclosure: boolean;
  max_promotional_posts_per_week?: number | null;
  promotional_participation_ratio_decimal?: string | null;
  require_minimum_membership_days?: number | null;
};

type CommunityProvenancePolicy = {
  community: string;
  policy_origin: CommunityPolicyOrigin;
  allowed_creator_relations: Array<CommunityCreatorRelation>;
  require_creator_relation: boolean;
  false_claim_consequence: CommunityFalseClaimConsequence;
  allow_oc_claim: boolean;
  require_proof_for_original: boolean;
};

type CommunityPurchaseFundingMode = "direct" | "routed";

type CommunityPurchaseSettlementMode = "delivery_only_story_settlement" | "royalty_native_story_payment";

type CommunityReferenceLinkMetadata = {
  display_name?: string | null;
  image_url?: string | null;
};

type CommunityReferenceLinkPlatform = "musicbrainz" | "genius" | "spotify" | "apple_music" | "wikipedia" | "instagram" | "tiktok" | "x" | "official_website" | "youtube" | "bandcamp" | "soundcloud" | "other";

type CommunityReferenceLinkPublic = {
  community_reference_link: string;
  platform: CommunityReferenceLinkPlatform;
  url: string;
  external?: string | null;
  label?: string | null;
  link_status: CommunityReferenceLinkStatus;
  verified: boolean;
  verified_at?: number | null;
  metadata: CommunityReferenceLinkMetadata;
  position: number;
};

type CommunityReferenceLinkStatus = "active" | "archived";

type CommunityResourceLink = {
  id: string;
  object: "community_resource_link";
  label: string;
  url: string;
  resource_kind: "link" | "playlist" | "document" | "discord" | "website" | "other";
  position: number;
  status: "active" | "archived";
};

type CommunityRule = {
  id: string;
  object: "community_rule";
  title: string;
  body: string;
  report_reason: string;
  position: number;
  status: "active" | "archived";
};

type CommunitySaleAllocationLeg = (CommunitySaleAllocationSnapshot & {
  status: CommunitySaleAllocationStatus;
  settlement_ref?: string | null;
  failure_reason?: string | null;
});

type CommunitySaleAllocationRecipientType = "creator" | "performer" | "charity" | "community_treasury";

type CommunitySaleAllocationSettlementStrategy = "story_payout" | "provider_payout" | "treasury_payout";

type CommunitySaleAllocationSnapshot = {
  recipient_type: CommunitySaleAllocationRecipientType;
  recipient_ref?: string | null;
  waterfall_position: number;
  share_bps: number;
  amount_cents: number;
  settlement_strategy: CommunitySaleAllocationSettlementStrategy;
};

type CommunitySaleAllocationStatus = "quoted" | "pending" | "confirmed" | "failed";

type CommunitySelfPromotionMode = "disallow" | "limited_with_disclosure" | "allowed_with_participation" | "creator_friendly";

type CommunitySongAuthenticityPolicySettings = {
  allow_ai_assisted_mastering: boolean;
  allow_ai_stem_separation: boolean;
  allow_ai_generated_instrumentals: boolean;
  allow_ai_generated_lyrics: boolean;
  allow_ai_generated_vocals: boolean;
};

type CommunitySourcePolicy = {
  community: string;
  policy_origin: CommunityPolicyOrigin;
  identified_person_media_scope: CommunityIdentifiedPersonMediaScope;
  require_source_url_for_reposts: boolean;
  allow_human_made_fan_art_of_real_people: boolean;
  require_fan_art_disclosure: boolean;
};

type CommunityTextAuthenticityPolicySettings = {
  allow_ai_assisted_editing: boolean;
  allow_ai_generated: boolean;
};

type CommunityTextLocalization = {
  resolved_locale: string;
  items: Array<CommunityTextLocalizationItem>;
};

type CommunityTextLocalizationItem = {
  field_key: string;
  translation_state: "ready" | "pending" | "same_language" | "policy_blocked";
  machine_translated: boolean;
  translated_value?: string | null;
  source_hash: string;
};

type CommunityVideoAuthenticityPolicySettings = {
  allow_ai_upscale: boolean;
  allow_ai_restoration: boolean;
  allow_ai_frame_interpolation: boolean;
  allow_generative_editing: boolean;
  allow_ai_generated: boolean;
};

type CommunityVisualPolicyAction = "allow" | "queue" | "reject";

type CommunityVisualPolicyDisclosureAction = "allow" | "allow_with_disclosure" | "queue" | "reject";

type CommunityVisualPolicySettings = {
  community: string;
  policy_origin: CommunityPolicyOrigin;
  topless: CommunityVisualPolicyAction;
  visible_nipples: CommunityVisualPolicyAction;
  visible_buttocks: CommunityVisualPolicyAction;
  visible_genitals: CommunityVisualPolicyAction;
  bottomless_obscured: CommunityVisualPolicyAction;
  implied_sexual_activity: CommunityVisualPolicyAction;
  explicit_sexual_activity: CommunityVisualPolicyAction;
  sexualized_contact: CommunityVisualPolicyAction;
  masturbation: CommunityVisualPolicyAction;
  oral_sex: CommunityVisualPolicyAction;
  sex_toy_packaging: CommunityVisualPolicyAction;
  sex_toy_visible: CommunityVisualPolicyAction;
  sex_toy_in_use: CommunityVisualPolicyAction;
  anime_manga: CommunityVisualPolicyAction;
  furry_anthro: CommunityVisualPolicyAction;
  fictional_nudity: CommunityVisualPolicyAction;
  fictional_explicit_sex: CommunityVisualPolicyAction;
  ambiguous_fictional_age_with_adult_content: "queue" | "reject";
  possible_minor_with_adult_content: "reject";
  ai_generated_images: CommunityVisualPolicyAction;
  ai_generated_adult_images: CommunityVisualPolicyAction;
  deepfake_or_face_swap_risk: "queue" | "reject";
  celebrity_adult_likeness: "queue" | "reject";
  voyeuristic_or_hidden_camera: "reject";
  watermark: CommunityVisualPolicyAction;
  adult_platform_watermark: CommunityVisualPolicyAction;
  product_promotion: CommunityVisualPolicyDisclosureAction;
  affiliate_or_sales_link: CommunityVisualPolicyDisclosureAction;
  qr_code: "queue" | "reject";
  payment_handle: "queue" | "reject";
  urls_in_image: CommunityVisualPolicyAction;
  weapons: CommunityVisualPolicyAction;
  gore_or_injury: CommunityVisualPolicyAction;
  drugs: CommunityVisualPolicyAction;
  hate_symbols: "queue" | "reject";
  personal_documents: "queue" | "reject";
  uncertain_age_with_adult_content: "queue" | "reject";
  low_quality_adult_image: "queue" | "reject";
  model_uncertain: "queue" | "reject";
};

type CreateCentralizedCommunityRequest = (CreateCommunityRequestBase & {
  governance_mode: "centralized";
});

type CreateCommunityAdultContentPolicyInput = {
  suggestive: CommunityModerationDecisionLevel;
  artistic_nudity: CommunityModerationDecisionLevel;
  explicit_nudity: CommunityModerationDecisionLevel;
  explicit_sexual_content: CommunityModerationDecisionLevel;
  fetish_content: CommunityModerationDecisionLevel;
};

type CreateCommunityBootstrapInput = {
  label_policy?: CreateCommunityLabelPolicyInput | null;
  rules?: Array<CreateCommunityRuleInput>;
  resource_links?: Array<CreateCommunityResourceLinkInput>;
};

type CreateCommunityCaptureEditPolicyInput = {
  basic_adjustments: CommunityDisclosureDecisionLevel;
  retouching: CommunityDisclosureDecisionLevel;
  compositing: CommunityDisclosureDecisionLevel;
  documentary_editing: CommunityDisclosureDecisionLevel;
  require_edit_disclosure: boolean;
};

type CreateCommunityCivilityPolicyInput = {
  group_directed_demeaning_language: CommunityModerationDecisionLevel;
  targeted_insults: CommunityModerationDecisionLevel;
  targeted_harassment: CommunityModerationDecisionLevel;
  threatening_language: CommunityEscalationDecisionLevel;
};

type CreateCommunityContentAuthenticityDetectionPolicyInput = {
  selection_mode: CommunityContentAuthenticityDetectionSelectionMode;
  authenticity_detection_profile?: string | null;
};

type CreateCommunityContentAuthenticityPolicyInput = {
  authenticity_stance: CommunityContentAuthenticityStance;
  text_policy: CommunityTextAuthenticityPolicySettings;
  image_policy: CommunityImageAuthenticityPolicySettings;
  video_policy: CommunityVideoAuthenticityPolicySettings;
  song_policy: CommunitySongAuthenticityPolicySettings;
};

type CreateCommunityDonationPolicyInput = {
  donation_policy_mode: "none" | "optional_creator_sidecar" | "fundraiser_default";
  donation_partner?: string | null;
};

type CreateCommunityGraphicContentPolicyInput = {
  injury_medical: CommunityModerationDecisionLevel;
  gore: CommunityModerationDecisionLevel;
  extreme_gore: CommunityModerationDecisionLevel;
  body_horror_disturbing: CommunityModerationDecisionLevel;
  animal_harm: CommunityModerationDecisionLevel;
};

type CreateCommunityLabelDefinitionInput = {
  label: string;
  description?: string | null;
  color_token?: string | null;
  position: number;
  allowed_post_types?: Array<"text" | "image" | "video" | "song"> | null;
};

type CreateCommunityLabelPolicyInput = {
  label_enabled?: boolean;
  require_label_on_top_level_posts?: boolean;
  definitions?: Array<CreateCommunityLabelDefinitionInput>;
};

type CreateCommunityLanguagePolicyInput = {
  profanity: CommunityModerationDecisionLevel;
  slurs: CommunityModerationDecisionLevel;
};

type CreateCommunityMarketContextPolicyInput = {
  mode: CommunityMarketContextMode;
  enabled_post_types?: Array<"link" | "image" | "video"> | null;
  max_markets_per_post?: number | null;
  provider_set?: CommunityMarketContextProviderSet | null;
  market_context_profile?: string | null;
};

type CreateCommunityMoneyPolicyInput = {
  funding_preference: string;
  accepted_funding_assets: Array<CommunityMoneyAssetRef>;
  accepted_source_chains: Array<CommunityMoneyChainRef>;
  approved_route_providers?: Array<string> | null;
  destination_settlement_chain: CommunityMoneyChainRef;
  destination_settlement_token: string;
  treasury_denomination?: string | null;
  max_slippage_bps: number;
  quote_ttl_seconds: number;
  route_required: boolean;
  route_status_policy: CommunityFundingRouteStatusPolicy;
  route_hop_tolerance: number;
};

type CreateCommunityMotionMediaPolicyInput = {
  allow_animated_images: boolean;
  allow_silent_looping_video: boolean;
  allow_audio_video: boolean;
  max_video_duration_seconds?: number | null;
  require_video_transcription?: boolean;
};

type CreateCommunityPromotionPolicyInput = {
  self_promotion_mode: CommunitySelfPromotionMode;
  require_affiliation_disclosure: boolean;
  max_promotional_posts_per_week?: number | null;
  promotional_participation_ratio_decimal?: string | null;
  require_minimum_membership_days?: number | null;
};

type CreateCommunityProvenancePolicyInput = {
  allowed_creator_relations: Array<CommunityCreatorRelation>;
  require_creator_relation: boolean;
  false_claim_consequence: CommunityFalseClaimConsequence;
  allow_oc_claim: boolean;
  require_proof_for_original: boolean;
};

type CreateCommunityRequestBase = {
  display_name: string;
  description?: string | null;
  database_region?: "auto" | "aws-us-east-1" | "aws-us-east-2" | "aws-us-west-2" | "aws-eu-west-1" | "aws-ap-south-1" | "aws-ap-northeast-1" | null;
  localized_text?: CommunityTextLocalization | null;
  avatar_ref?: string | null;
  banner_ref?: string | null;
  artist_identity?: string | null;
  membership_mode: "open" | "request" | "gated";
  allow_anonymous_identity: boolean;
  anonymous_identity_scope?: "community_stable" | "thread_stable" | "post_ephemeral" | null;
  allowed_disclosed_qualifiers?: Array<string> | null;
  allow_qualifiers_on_anonymous_posts?: boolean | null;
  guest_comment_policy?: "disallow" | "altcha_required" | null;
  root_post_min_trust_tier?: "new" | "established" | "trusted" | "high_trust" | null;
  reply_min_trust_tier?: "new" | "established" | "trusted" | "high_trust" | null;
  anonymous_posting_min_trust_tier?: "new" | "established" | "trusted" | "high_trust" | null;
  root_post_quota_by_trust_tier?: RootPostQuotaByTrustTier | null;
  reply_quota_by_trust_tier?: ReplyQuotaByTrustTier | null;
  probation_window_days?: number | null;
  link_post_policy?: "allow" | "require_established" | null;
  default_age_gate_policy?: "none" | "18_plus";
  gate_policy?: GatePolicy | null;
  agent_posting_policy?: "disallow" | "review" | "allow_with_disclosure" | "allow" | null;
  agent_posting_scope?: "replies_only" | "top_level_and_replies" | null;
  agent_daily_post_cap?: number | null;
  agent_daily_reply_cap?: number | null;
  agent_min_owner_trust_tier?: "new" | "established" | "trusted" | "high_trust" | null;
  agent_owner_active_limit?: number | null;
  human_verification_lane?: "very" | "self" | null;
  accepted_agent_ownership_providers?: Array<AgentOwnershipProvider> | null;
  namespace?: NamespaceAttachmentInput | null;
  handle_policy: HandlePolicyInput;
  donation_policy?: (CreateCommunityDonationPolicyInput & Record<string, never>) | null;
  content_authenticity_policy?: (CreateCommunityContentAuthenticityPolicyInput & Record<string, never>) | null;
  source_policy?: (CreateCommunitySourcePolicyInput & Record<string, never>) | null;
  capture_edit_policy?: (CreateCommunityCaptureEditPolicyInput & Record<string, never>) | null;
  adult_content_policy?: (CreateCommunityAdultContentPolicyInput & Record<string, never>) | null;
  graphic_content_policy?: (CreateCommunityGraphicContentPolicyInput & Record<string, never>) | null;
  motion_media_policy?: (CreateCommunityMotionMediaPolicyInput & Record<string, never>) | null;
  language_policy?: (CreateCommunityLanguagePolicyInput & Record<string, never>) | null;
  civility_policy?: (CreateCommunityCivilityPolicyInput & Record<string, never>) | null;
  provenance_policy?: (CreateCommunityProvenancePolicyInput & Record<string, never>) | null;
  promotion_policy?: (CreateCommunityPromotionPolicyInput & Record<string, never>) | null;
  content_authenticity_detection_policy?: (CreateCommunityContentAuthenticityDetectionPolicyInput & Record<string, never>) | null;
  market_context_policy?: (CreateCommunityMarketContextPolicyInput & Record<string, never>) | null;
  money_policy?: (CreateCommunityMoneyPolicyInput & Record<string, never>) | null;
  community_bootstrap?: CreateCommunityBootstrapInput | null;
  gate_rules?: Array<GateRuleInput> | null;
};

type CreateCommunityResourceLinkInput = {
  label: string;
  url: string;
  resource_kind: "link" | "playlist" | "document" | "discord" | "website" | "other";
  position: number;
};

type CreateCommunityRuleInput = {
  title: string;
  body: string;
  report_reason?: string | null;
  position: number;
};

type CreateCommunitySourcePolicyInput = {
  identified_person_media_scope: CommunityIdentifiedPersonMediaScope;
  require_source_url_for_reposts: boolean;
  allow_human_made_fan_art_of_real_people: boolean;
  require_fan_art_disclosure: boolean;
};

type CreateMajeurCommunityRequest = (CreateCommunityRequestBase & {
  governance_mode: "majeur";
  governance_backend: MajeurGovernanceCreateInput;
});

type CreateMultisigCommunityRequest = (CreateCommunityRequestBase & {
  governance_mode: "multisig";
  governance_backend: MultisigGovernanceAttachmentInput;
});

type DisclosedQualifierSnapshot = {
  qualifier_template: string;
  rendered_label: string;
  qualifier_kind: "verification_capability" | "provider_attestation";
  qualifier_source: string;
  sensitivity_level?: "low" | "high" | null;
  redundancy_key?: string | null;
};

type DonationPartnerSummary = {
  donation_partner: string;
  display_name: string;
  provider: "endaoment";
  provider_partner_ref?: string | null;
  image_url?: string | null;
  review_status: "pending" | "approved" | "rejected";
  status: "active" | "paused" | "retired";
};

type FeedItem = {
  community: HomeFeedCommunitySummary;
  post: LocalizedPostResponse;
};

type GatePolicyEvaluation = {
  passed: boolean;
  trace: GateTraceNode;
  required_action_set: RequiredActionSet | null;
};

type GateRule = {
  id: string;
  object: "gate_rule";
  community: string;
  scope: "membership" | "viewer" | "posting";
  gate_family: "token_holding" | "identity_proof";
  gate_type: "unique_human" | "age_over_18" | "minimum_age" | "nationality" | "gender" | "wallet_score" | "erc721_holding" | "erc721_inventory_match";
  proof_requirements?: Array<ProofRequirement> | null;
  chain_namespace?: string | null;
  gate_config?: (Record<string, unknown>) | null;
  status: "active" | "disabled";
  created: number;
};

type GateRuleInput = {
  scope: "membership" | "viewer" | "posting";
  gate_family: "token_holding" | "identity_proof";
  gate_type: "unique_human" | "age_over_18" | "minimum_age" | "nationality" | "gender" | "wallet_score" | "altcha_pow" | "erc721_holding" | "erc721_inventory_match";
  proof_requirements?: Array<ProofRequirement> | null;
  chain_namespace?: string | null;
  gate_config?: (Record<string, unknown>) | null;
};

type GateTraceNode = {
  kind: "op" | "gate";
  op?: "and" | "or";
  gate_type?: string;
  provider?: string;
  passed: boolean;
  reason?: string;
  required_score?: number | null;
  actual_score?: number | null;
  required_age?: number | null;
  children?: Array<Record<string, unknown>>;
};

type GovernanceVerificationState = "not_required" | "pending" | "verified" | "broken";

type HandlePolicyInput = {
  policy_template: "standard" | "premium" | "membership_gated" | "custom";
  pricing_model?: "free" | "flat_by_length" | "custom_curve" | "gated_then_flat" | null;
};

type HumanVerificationLane = "very" | "self";

type ImageMediaDescriptor = {
  storage_ref: string;
  mime_type: string;
  size_bytes?: number | null;
  content_hash?: string | null;
  width?: number | null;
  height?: number | null;
};

type InitialLiveSetlistInput = {
  status: "draft" | "active";
  items: Array<LiveSetlistItemInput>;
};

type KalshiMarketEmbed = {
  embed: string;
  embed_key: string;
  provider: "kalshi";
  provider_ref?: string | null;
  canonical_url: string;
  original_url: string;
  state: "pending" | "preview" | "embed" | "unavailable";
  preview?: PredictionMarketEmbedPreview | null;
  oembed_html?: string | null;
  oembed_cache_age?: number | null;
  unavailable_reason?: "deleted" | "withheld" | "private" | "unsupported" | "unknown" | null;
  last_checked_at?: number | null;
};

type LiveRoomPerformerAllocationInput = {
  user: string;
  role: "host" | "guest";
  share_pct: number;
};

type LiveRoomReplayAssetAccessMode = "free" | "included_with_ticket" | "paid";

type LiveRoomReplayDraftAllocationInput = {
  participant_user?: string | null;
  external_party_ref?: string | null;
  role?: string | null;
  share_bps?: number;
};

type LiveRoomReplayDraftStatus = "not_recorded" | "processing" | "ready" | "published" | "failed";

type LiveRoomReplayRawArtifact = {
  provider: "filebase";
  ipfs_cid: string;
  mime_type: string;
  size_bytes: number;
};

type LiveRoomReplayRecording = {
  id: string;
  provider: "agora";
  status: string;
  failure_reason: string | null;
  raw_artifact: LiveRoomReplayRawArtifact | null;
};

type LiveSetlistItemInput = unknown;

type MajeurGovernanceBackend = {
  governance_mode: "majeur";
  governance_chain: number;
  governance_contract_address: string;
  governance_treasury_address?: string | null;
  governance_verification_state: GovernanceVerificationState;
  governance_display_label?: string | null;
  governance_attached_at?: number | null;
  governance_last_verified_at?: number | null;
  governance_metadata: MajeurGovernanceMetadata;
};

type MajeurGovernanceCreateInput = {
  chain: number;
  summon: MajeurSafeSummonInput;
};

type MajeurGovernanceMetadata = {
  shares_address: string;
  loot_address: string;
  badges_address: string;
  renderer_address?: string | null;
  ragequittable: boolean;
  proposal_threshold: string;
  proposal_ttl_seconds: number;
  timelock_delay_seconds?: number | null;
  quorum_bps?: number | null;
  quorum_absolute?: string | null;
  min_yes_votes_absolute?: string | null;
  shares_locked: boolean;
  loot_locked: boolean;
  auto_futarchy_param?: string | null;
  auto_futarchy_cap?: string | null;
  futarchy_reward_token?: string | null;
  config_version: number;
};

type MajeurSafeConfigInput = {
  proposal_threshold: string;
  proposal_ttl_seconds: number;
  timelock_delay_seconds?: number | null;
  quorum_absolute?: string | null;
  min_yes_votes_absolute?: string | null;
  lock_shares?: boolean;
  lock_loot?: boolean;
  rollback_guardian?: string | null;
  rollback_singleton?: string | null;
  rollback_expiry?: number | null;
};

type MajeurSafeSummonInput = {
  preset?: "founder" | "standard" | "fast" | "custom" | null;
  org_name: string;
  org_symbol: string;
  org_uri?: string | null;
  quorum_bps?: number | null;
  ragequittable: boolean;
  renderer?: string | null;
  init_holders: Array<string>;
  init_shares: Array<string>;
  init_loot?: Array<string> | null;
  config: MajeurSafeConfigInput;
};

type MarketContextMarket = {
  provider_key: string;
  question: string;
  outcome_yes_price: string;
  liquidity_score?: string | null;
  resolve_date?: number | null;
  market_url: string;
  snapshot_at: number;
};

type MarketContextProfileStatus = "active" | "archived";

type MarketContextProfileSummary = {
  market_context_profile: string;
  profile_key: string;
  provider_keys: Array<string>;
  status: MarketContextProfileStatus;
};

type MarketContextSummary = {
  status: "attached" | "no_match";
  claim_summary?: string | null;
  markets?: Array<MarketContextMarket> | null;
};

type MediaDescriptor = {
  storage_ref: string;
  mime_type?: string | null;
  size_bytes?: number | null;
  content_hash?: string | null;
  decentralized_storage?: (Record<string, unknown>) | null;
  duration_ms?: number | null;
  poster_ref?: string | null;
  poster_mime_type?: string | null;
  poster_size_bytes?: number | null;
  poster_width?: number | null;
  poster_height?: number | null;
  poster_frame_ms?: number | null;
  preview_video?: SongVideoArtifactDescriptor | null;
};

type ModerationCaseOpenedBy = "platform_analysis" | "user_report" | "mixed";

type ModerationCaseStatus = "open" | "resolved";

type ModerationQueueScope = "community" | "platform";

type MultisigAttachmentProofInput = {
  proof_kind: "eip1271";
  challenge: string;
  signature: string;
};

type MultisigGovernanceAttachmentInput = {
  chain: number;
  contract_address: string;
  treasury_address?: string | null;
  attachment_proof: MultisigAttachmentProofInput;
};

type MultisigGovernanceBackend = {
  governance_mode: "multisig";
  governance_chain: number;
  governance_contract_address: string;
  governance_treasury_address?: string | null;
  governance_verification_state: GovernanceVerificationState;
  governance_display_label?: string | null;
  governance_attached_at?: number | null;
  governance_last_verified_at?: number | null;
  governance_metadata: MultisigGovernanceMetadata;
};

type MultisigGovernanceMetadata = {
  owners: Array<string>;
  threshold: number;
  is_safe_compatible: boolean;
  version_label?: string | null;
  master_copy_address?: string | null;
};

type NamespaceAttachmentInput = {
  namespace_verification: string;
  display_label?: string;
  normalized_label?: string;
  resolver_label?: string | null;
  route_family?: string | null;
};

type PolymarketMarketEmbed = {
  embed: string;
  embed_key: string;
  provider: "polymarket";
  provider_ref?: string | null;
  canonical_url: string;
  original_url: string;
  state: "pending" | "preview" | "embed" | "unavailable";
  preview?: PredictionMarketEmbedPreview | null;
  oembed_html?: string | null;
  oembed_cache_age?: number | null;
  unavailable_reason?: "deleted" | "withheld" | "private" | "unsupported" | "unknown" | null;
  last_checked_at?: number | null;
};

type PostCreatorRelation = "captured" | "created" | "subject" | "authorized_repost" | "fan_work" | "found";

type PostEmbed = (XPostEmbed | YouTubeVideoEmbed | KalshiMarketEmbed | PolymarketMarketEmbed);

type PostLabel = {
  id: string;
  object: "post_label";
  label: string;
  color_token?: string | null;
  status: "active" | "archived";
};

type PredictionMarketChartPoint = {
  ts: number;
  price?: number | null;
  volume?: number | null;
  open_interest?: number | null;
};

type PredictionMarketEmbedPreview = {
  question?: string | null;
  title?: string | null;
  image_url?: string | null;
  yes_price?: number | null;
  yes_bid?: number | null;
  yes_ask?: number | null;
  no_bid?: number | null;
  no_ask?: number | null;
  last_price?: number | null;
  volume?: number | null;
  volume_24h?: number | null;
  liquidity?: number | null;
  open_interest?: number | null;
  status?: string | null;
  resolution?: "yes" | "no" | null;
  resolved_outcome?: string | null;
  close_time?: string | null;
  updated_at?: string | null;
  chart?: Array<PredictionMarketChartPoint> | null;
  outcomes?: Array<PredictionMarketOutcome> | null;
};

type PredictionMarketOutcome = {
  label: string;
  probability: number;
};

type PromotionAffiliationKind = "self" | "brand" | "client" | "partner" | "employer" | "other";

type PromotionDisclosure = {
  is_promotional: boolean;
  affiliation_kind: PromotionAffiliationKind;
};

type ProofRequirement = {
  proof_type: "unique_human" | "biometric_liveness" | "wallet_score" | "sanctions_clear" | "gov_id" | "age_over_18" | "minimum_age" | "nationality" | "gender" | "phone";
  accepted_providers?: Array<"self" | "zkpassport" | "very" | "passport"> | null;
  accepted_mechanisms?: Array<string> | null;
  config?: (Record<string, unknown>) | null;
};

type ReplyQuotaByTrustTier = {
  new?: ReplyQuotaRule;
  established?: ReplyQuotaRule;
  trusted?: ReplyQuotaRule;
  high_trust?: ReplyQuotaRule;
};

type ReplyQuotaRule = {
  window_hours: number;
  max_replies: number;
  burst_window_minutes: number;
  max_replies_per_burst: number;
};

type RequiredActionNode = {
  kind: "action" | "set";
  mode?: "all" | "any";
  items?: Array<Record<string, unknown>>;
  provider?: "self" | "zkpassport" | "very" | "passport" | "wallet" | "altcha";
  accepted_providers?: Array<"self" | "zkpassport"> | null;
  capability?: "minimum_age" | "nationality" | "gender" | "unique_human" | "wallet_score" | "altcha_pow" | "erc721_holding" | "erc721_inventory_match";
  scope?: string;
  required_age?: number;
  allowed_countries?: Array<string>;
  allowed_markers?: Array<"M" | "F">;
  minimum_score?: number;
  actual_score?: number | null;
  chain_namespace?: string;
  contract_address?: string;
  min_quantity?: number;
};

type RequiredActionSet = {
  kind: "set";
  mode: "all" | "any";
  items: Array<RequiredActionNode>;
};

type RootPostQuotaByTrustTier = {
  new?: RootPostQuotaRule;
  established?: RootPostQuotaRule;
  trusted?: RootPostQuotaRule;
  high_trust?: RootPostQuotaRule;
};

type RootPostQuotaRule = {
  window_hours: number;
  max_root_posts: number;
  max_song_posts: number;
  max_video_posts: number;
};

type SongArtifactUploadRef = {
  song_artifact_upload: string;
};

type SongImageArtifactDescriptor = {
  storage_ref: string;
  mime_type: string;
  size_bytes?: number | null;
  content_hash?: string | null;
  upload_mode?: "proxy" | "direct_multipart";
  width?: number | null;
  height?: number | null;
};

type SongPreviewWindow = {
  start_ms: number;
  duration_ms: number;
};

type SongVideoArtifactDescriptor = {
  storage_ref: string;
  mime_type: string;
  size_bytes?: number | null;
  content_hash?: string | null;
  duration_ms?: number | null;
  clip_start_ms?: number | null;
  clip_duration_ms?: number | null;
  width?: number | null;
  height?: number | null;
};

type VerificationCapabilityState = {
  state: "unverified" | "pending" | "verified" | "expired";
  provider?: "self" | "very" | null;
  proof_type?: "unique_human" | null;
  mechanism?: string | null;
  verified_at?: number | null;
};

type VerifiedCapabilityState = {
  state: "unverified" | "verified" | "expired";
  provider?: "self" | "zkpassport" | null;
  proof_type?: "age_over_18" | "minimum_age" | "nationality" | "gender" | null;
  mechanism?: string | null;
  verified_at?: number | null;
};

type VideoMediaDescriptor = {
  storage_ref: string;
  mime_type: string;
  size_bytes?: number | null;
  content_hash?: string | null;
  duration_ms?: number | null;
  width?: number | null;
  height?: number | null;
  poster_ref?: string | null;
  poster_mime_type?: string | null;
  poster_size_bytes?: number | null;
  poster_width?: number | null;
  poster_height?: number | null;
  poster_frame_ms?: number | null;
  preview_video?: SongVideoArtifactDescriptor | null;
};

type WalletScoreCapabilityState = {
  state: "unverified" | "verified" | "expired";
  provider?: "passport" | null;
  proof_type?: "wallet_score" | null;
  mechanism?: "stamps-api-v2" | null;
  verified_at?: number | null;
  score_decimal?: string | null;
  score_threshold_decimal?: string | null;
  passing_score?: boolean | null;
  last_scored_at?: number | null;
  expires_at?: number | null;
  stamps?: Array<{
    stamp_name?: string;
    stamp_score_decimal?: string;
  }> | null;
};

type XEmbedPreview = {
  author_name?: string | null;
  author_url?: string | null;
  text?: string | null;
  has_media?: boolean;
  media_url?: string | null;
  created?: string | null;
};

type XPostEmbed = {
  embed: string;
  embed_key: string;
  provider: "x";
  provider_ref?: string | null;
  canonical_url: string;
  original_url: string;
  state: "pending" | "preview" | "embed" | "unavailable";
  preview?: XEmbedPreview | null;
  oembed_html?: string | null;
  oembed_cache_age?: number | null;
  unavailable_reason?: "deleted" | "withheld" | "private" | "unsupported" | "unknown" | null;
  last_checked_at?: number | null;
};

type YouTubeEmbedPreview = {
  title?: string | null;
  author_name?: string | null;
  author_url?: string | null;
  thumbnail_url?: string | null;
  thumbnail_width?: number | null;
  thumbnail_height?: number | null;
};

type YouTubeVideoEmbed = {
  embed: string;
  embed_key: string;
  provider: "youtube";
  provider_ref?: string | null;
  canonical_url: string;
  original_url: string;
  state: "pending" | "preview" | "embed" | "unavailable";
  preview?: YouTubeEmbedPreview | null;
  oembed_html?: string | null;
  oembed_cache_age?: number | null;
  unavailable_reason?: "deleted" | "withheld" | "private" | "unsupported" | "unknown" | null;
  last_checked_at?: number | null;
};

type ZkPassportVerificationLaunch = {
  domain: string;
  name: string;
  logo?: string | null;
  purpose: string;
  scope: string;
  binding: string;
  validity_seconds?: number | null;
  dev_mode?: boolean | null;
  requested_capabilities: Array<RequestedVerificationCapability>;
  verification_requirements: Array<VerificationRequirement>;
};

export const apiRoutes = {
  authSessionExchange: "/auth/session/exchange",
  usersMe: "/users/me",
  profilesMe: "/profiles/me",
  walletIdentity: (chainRef: string, walletAddress: string) => `/wallet-identities/${chainRef}/${walletAddress}`,
  publicNameQuotes: "/public-names/quotes",
  publicNameClaims: "/public-names/claims",
  publicNameStatus: (label: string) => `/public-names/${label}/status`,
  onboardingStatus: "/onboarding/status",
  onboardingDismiss: "/onboarding/dismiss",
  onboardingRedditVerification: "/onboarding/reddit-verification",
  onboardingRedditImports: "/onboarding/reddit-imports",
  onboardingRedditImportsLatest: "/onboarding/reddit-imports/latest",
  verificationSessions: "/verification-sessions",
  verificationSession: (verificationSessionId: string) => `/verification-sessions/${verificationSessionId}`,
  verificationSessionComplete: (verificationSessionId: string) => `/verification-sessions/${verificationSessionId}/complete`,
  passportWalletScore: "/verification/passport-wallet-score",
  altchaChallenge: "/verification/altcha/challenge",
  agentOwnershipSessions: "/agent-ownership-sessions",
  agentOwnershipPairing: "/agent-ownership-pairing",
  agentOwnershipPairingClaim: "/agent-ownership-pairing/claim",
  agentOwnershipSession: (agentOwnershipSessionId: string) => `/agent-ownership-sessions/${agentOwnershipSessionId}`,
  agentOwnershipSessionComplete: (agentOwnershipSessionId: string) => `/agent-ownership-sessions/${agentOwnershipSessionId}/complete`,
  agents: "/agents",
  agent: (agentId: string) => `/agents/${agentId}`,
  agentHandle: (agentId: string) => `/agents/${agentId}/handle`,
  agentCredential: (agentId: string) => `/agents/${agentId}/credential`,
  agentCredentialRefresh: (agentId: string) => `/agents/${agentId}/refresh-credential`,
  publicAgent: (handleLabel: string) => `/public-agents/${handleLabel}`,
  namespaceVerificationSessions: "/namespace-verification-sessions",
  namespaceVerificationSession: (namespaceVerificationSessionId: string) => `/namespace-verification-sessions/${namespaceVerificationSessionId}`,
  namespaceVerificationSessionComplete: (namespaceVerificationSessionId: string) => `/namespace-verification-sessions/${namespaceVerificationSessionId}/complete`,
  namespaceVerification: (namespaceVerificationId: string) => `/namespace-verifications/${namespaceVerificationId}`,
  communities: "/communities",
  communitiesAdminHealth: "/communities/admin/health",
  community: (communityId: string) => `/communities/${communityId}`,
  communityMoneyPolicy: (communityId: string) => `/communities/${communityId}/money-policy`,
  communityPricingPolicy: (communityId: string) => `/communities/${communityId}/pricing-policy`,
  communityListings: (communityId: string) => `/communities/${communityId}/listings`,
  communityListing: (communityId: string, listingId: string) => `/communities/${communityId}/listings/${listingId}`,
  communityPurchases: (communityId: string) => `/communities/${communityId}/purchases`,
  communityPurchase: (communityId: string, purchaseId: string) => `/communities/${communityId}/purchases/${purchaseId}`,
  communityPurchaseQuotePreflight: (communityId: string) => `/communities/${communityId}/purchase-quote-preflight`,
  communityPurchaseQuotes: (communityId: string) => `/communities/${communityId}/purchase-quotes`,
  communityPurchaseSettlements: (communityId: string) => `/communities/${communityId}/purchase-settlements`,
  communityPurchaseSettlementFailures: (communityId: string) => `/communities/${communityId}/fail-purchase-settlement`,
  communityFollow: (communityId: string) => `/communities/${communityId}/follow`,
  communityUnfollow: (communityId: string) => `/communities/${communityId}/unfollow`,
  communityPosts: (communityId: string) => `/communities/${communityId}/posts`,
  communityPostComments: (communityId: string, postId: string) => `/communities/${communityId}/posts/${postId}/comments`,
  communityPostReports: (communityId: string, postId: string) => `/communities/${communityId}/posts/${postId}/reports`,
  communityCommentReports: (communityId: string, commentId: string) => `/communities/${communityId}/comments/${commentId}/reports`,
  communityModerationCases: (communityId: string) => `/communities/${communityId}/moderation/cases`,
  communityModerationCase: (communityId: string, moderationCaseId: string) => `/communities/${communityId}/moderation/cases/${moderationCaseId}`,
  communityModerationCaseActions: (communityId: string, moderationCaseId: string) => `/communities/${communityId}/moderation/cases/${moderationCaseId}/actions`,
  communityPreview: (communityId: string) => `/communities/${communityId}/preview`,
  communityJoinEligibility: (communityId: string) => `/communities/${communityId}/join-eligibility`,
  communityJoin: (communityId: string) => `/communities/${communityId}/join`,
  communityMembershipRequests: (communityId: string) => `/communities/${communityId}/membership-requests`,
  communityMembershipRequestApprove: (communityId: string, membershipRequestId: string) => `/communities/${communityId}/membership-requests/${membershipRequestId}/approve`,
  communityMembershipRequestReject: (communityId: string, membershipRequestId: string) => `/communities/${communityId}/membership-requests/${membershipRequestId}/reject`,
  communitySongArtifactUploads: (communityId: string) => `/communities/${communityId}/song-artifact-uploads`,
  communitySongArtifactUploadContent: (communityId: string, songArtifactUploadId: string) => `/communities/${communityId}/song-artifact-uploads/${songArtifactUploadId}/content`,
  communitySongArtifacts: (communityId: string) => `/communities/${communityId}/song-artifacts`,
  communitySongArtifact: (communityId: string, songArtifactBundleId: string) => `/communities/${communityId}/song-artifacts/${songArtifactBundleId}`,
  communityLiveRoomReplayDraft: (communityId: string, liveRoomId: string) => `/communities/${communityId}/live-rooms/${liveRoomId}/replay-draft`,
  communityLiveRoomReplayDraftPublish: (communityId: string, liveRoomId: string) => `/communities/${communityId}/live-rooms/${liveRoomId}/replay-draft/publish`,
  communityLiveRoomReplayAccess: (communityId: string, liveRoomId: string) => `/communities/${communityId}/live-rooms/${liveRoomId}/replay/access`,
  communityLiveRoomReplayContent: (communityId: string, liveRoomId: string) => `/communities/${communityId}/live-rooms/${liveRoomId}/replay/content`,
  publicCommunityLiveRoomReplayAccess: (communityId: string, liveRoomId: string) => `/public-communities/${communityId}/live-rooms/${liveRoomId}/replay/access`,
  publicCommunityLiveRoomReplayContent: (communityId: string, liveRoomId: string) => `/public-communities/${communityId}/live-rooms/${liveRoomId}/replay/content`,
  job: (jobId: string) => `/jobs/${jobId}`,
  post: (postId: string) => `/posts/${postId}`,
  postVote: (postId: string) => `/posts/${postId}/vote`,
  communityPostRemove: (communityId: string, postId: string) => `/communities/${communityId}/posts/${postId}/remove`,
  communityPostCommentsLock: (communityId: string, postId: string) => `/communities/${communityId}/posts/${postId}/comments-lock`,
  commentRemove: (commentId: string) => `/comments/${commentId}/remove`,
  commentDelete: (commentId: string) => `/comments/${commentId}/delete`,
  commentRepliesLock: (commentId: string) => `/comments/${commentId}/replies-lock`,
  commentReplies: (commentId: string) => `/comments/${commentId}/replies`,
  commentContext: (commentId: string) => `/comments/${commentId}/context`,
  commentVote: (commentId: string) => `/comments/${commentId}/vote`,
  notificationsSummary: "/notifications/summary",
  notificationsTasks: "/notifications/tasks",
  notificationsFeed: "/notifications/feed",
  notificationsMarkRead: "/notifications/mark-read",
  notificationsDismissTask: "/notifications/dismiss-task",
  communityPostKaraokeSession: (communityId: string, postId: string) => `/communities/${communityId}/posts/${postId}/karaoke/sessions`,
  karaokeSessionWebsocket: (sessionId: string) => `/karaoke/sessions/${sessionId}/websocket`,
} as const
