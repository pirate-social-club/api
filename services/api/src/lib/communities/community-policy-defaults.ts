import type { Community } from "../../types"

function defaultPolicyFields(communityId: string, updatedAt: string) {
  return {
    community_id: communityId,
    policy_origin: "default" as const,
    updated_at: updatedAt,
  }
}

export function buildDefaultContentAuthenticityPolicy(communityId: string, updatedAt: string): Community["content_authenticity_policy"] {
  return {
    ...defaultPolicyFields(communityId, updatedAt),
    authenticity_stance: "human_first",
    text_policy: {
      allow_ai_assisted_editing: false,
      allow_ai_generated: false,
    },
    image_policy: {
      allow_ai_upscale: false,
      allow_ai_restoration: false,
      allow_generative_editing: false,
      allow_ai_generated: false,
    },
    video_policy: {
      allow_ai_upscale: false,
      allow_ai_restoration: false,
      allow_ai_frame_interpolation: false,
      allow_generative_editing: false,
      allow_ai_generated: false,
    },
    song_policy: {
      allow_ai_assisted_mastering: false,
      allow_ai_stem_separation: false,
      allow_ai_generated_instrumentals: false,
      allow_ai_generated_lyrics: false,
      allow_ai_generated_vocals: false,
    },
  }
}

export function buildDefaultMoneyPolicy(communityId: string): Community["money_policy"] {
  return {
    community_id: communityId,
    policy_origin: "default",
    funding_preference: "WIP",
    accepted_funding_assets: [{
      asset_symbol: "WIP",
      chain_namespace: "eip155",
      chain_id: 1315,
      display_name: "WIP",
    }],
    accepted_source_chains: [{
      chain_namespace: "eip155",
      chain_id: 1315,
      display_name: "Story Aeneid",
    }],
    approved_route_providers: null,
    destination_settlement_chain: {
      chain_namespace: "eip155",
      chain_id: 1315,
      display_name: "Story Aeneid",
    },
    destination_settlement_token: "WIP",
    treasury_denomination: "WIP",
    max_slippage_bps: 150,
    quote_ttl_seconds: 900,
    route_required: false,
    route_status_policy: "fail",
    route_hop_tolerance: 0,
    updated_at: new Date(0).toISOString(),
  }
}

export function buildDefaultSourcePolicy(communityId: string, updatedAt: string): Community["source_policy"] {
  return {
    ...defaultPolicyFields(communityId, updatedAt),
    identified_person_media_scope: "subject_only",
    require_source_url_for_reposts: true,
    allow_human_made_fan_art_of_real_people: false,
    require_fan_art_disclosure: false,
  }
}

export function buildDefaultContentAuthenticityDetectionPolicy(
  communityId: string,
  updatedAt: string,
): Community["content_authenticity_detection_policy"] {
  return {
    ...defaultPolicyFields(communityId, updatedAt),
    selection_mode: "platform_default",
    resolved_profile: {
      authenticity_detection_profile_id: "authdet_default_v0",
      profile_key: "platform-default-v0",
      provider_key: "platform_default",
      supported_capabilities: ["image_authenticity", "video_authenticity", "audio_authenticity", "deepfake_detection"],
      status: "active",
    },
  }
}

export function buildDefaultMarketContextPolicy(communityId: string, updatedAt: string): Community["market_context_policy"] {
  return {
    ...defaultPolicyFields(communityId, updatedAt),
    mode: "off",
    enabled_post_types: ["link"],
    max_markets_per_post: 1,
    provider_set: "platform_default",
    resolved_profile: {
      market_context_profile_id: "marketctx_default_v0",
      profile_key: "platform-default-v0",
      provider_keys: ["platform_default"],
      status: "active",
    },
  }
}

export function buildDefaultCaptureEditPolicy(communityId: string, updatedAt: string): Community["capture_edit_policy"] {
  return {
    ...defaultPolicyFields(communityId, updatedAt),
    basic_adjustments: "allow",
    retouching: "disallow",
    compositing: "disallow",
    documentary_editing: "disallow",
    require_edit_disclosure: false,
  }
}

export function buildDefaultAdultContentPolicy(
  communityId: string,
  updatedAt: string,
  defaultAgeGatePolicy: Community["default_age_gate_policy"],
): Community["adult_content_policy"] {
  if (defaultAgeGatePolicy === "18_plus") {
    return {
      ...defaultPolicyFields(communityId, updatedAt),
      suggestive: "allow",
      artistic_nudity: "review",
      explicit_nudity: "disallow",
      explicit_sexual_content: "disallow",
      fetish_content: "disallow",
    }
  }

  return {
    ...defaultPolicyFields(communityId, updatedAt),
    suggestive: "review",
    artistic_nudity: "disallow",
    explicit_nudity: "disallow",
    explicit_sexual_content: "disallow",
    fetish_content: "disallow",
  }
}

export function buildDefaultGraphicContentPolicy(communityId: string, updatedAt: string): Community["graphic_content_policy"] {
  return {
    ...defaultPolicyFields(communityId, updatedAt),
    injury_medical: "review",
    gore: "disallow",
    extreme_gore: "disallow",
    body_horror_disturbing: "disallow",
    animal_harm: "disallow",
  }
}

export function buildDefaultMotionMediaPolicy(communityId: string, updatedAt: string): Community["motion_media_policy"] {
  return {
    ...defaultPolicyFields(communityId, updatedAt),
    allow_animated_images: true,
    allow_silent_looping_video: true,
    allow_audio_video: true,
    max_video_duration_seconds: null,
    require_video_transcription: false,
  }
}

export function buildDefaultLanguagePolicy(communityId: string, updatedAt: string): Community["language_policy"] {
  return {
    ...defaultPolicyFields(communityId, updatedAt),
    profanity: "allow",
    slurs: "disallow",
  }
}

export function buildDefaultProvenancePolicy(communityId: string, updatedAt: string): Community["provenance_policy"] {
  return {
    ...defaultPolicyFields(communityId, updatedAt),
    allowed_creator_relations: ["captured", "created", "subject", "authorized_repost", "fan_work", "found"],
    require_creator_relation: false,
    false_claim_consequence: "post_removed",
    allow_oc_claim: false,
    require_proof_for_original: false,
  }
}

export function buildDefaultPromotionPolicy(communityId: string, updatedAt: string): Community["promotion_policy"] {
  return {
    ...defaultPolicyFields(communityId, updatedAt),
    self_promotion_mode: "limited_with_disclosure",
    require_affiliation_disclosure: true,
    max_promotional_posts_per_week: 1,
    promotional_participation_ratio: null,
    require_minimum_membership_days: 7,
  }
}

export function buildDefaultCivilityPolicy(communityId: string, updatedAt: string): Community["civility_policy"] {
  return {
    ...defaultPolicyFields(communityId, updatedAt),
    group_directed_demeaning_language: "review",
    targeted_insults: "review",
    targeted_harassment: "disallow",
    threatening_language: "disallow",
  }
}
