export const BOOKING_SETTLEMENT_RESOLVE_SCOPE = "bookings:settlement:resolve"
export const REWARD_CAMPAIGN_INCIDENT_RESOLVE_SCOPE = "rewards:campaign-incidents:resolve"
export const REWARD_SETTLEMENT_READ_SCOPE = "rewards:settlement:read"
export const REWARD_REHEARSAL_EXECUTE_SCOPE = "rewards:rehearsal:execute"
export const REWARD_SETTLEMENT_RESOLVE_SCOPE = "rewards:settlement:resolve"
export const STORY_SETTLEMENT_REPAIR_SCOPE = "story:settlement:repair"
export const STORY_SETTLEMENT_FEE_REPLACE_SCOPE = "story:settlement:fee-replace"
export const DANCE_CHOREOGRAPHY_SEED_SCOPE = "dance:choreography:seed"
export const CONTENT_SECURITY_SCANNER_RELEASE_MANAGE_SCOPE = "content-security:scanner-releases:manage"
export const GENERIC_ASSET_EMERGENCY_CONTROLS_MANAGE_SCOPE = "generic-assets:emergency-controls:manage"
export const ADMIN_USERS_ACT_AS_SCOPE = "admin:users:act_as"
export const ADMIN_USERS_MANAGE_SCOPE = "admin:users:manage"
export const ADMIN_OPERATIONS_MANAGE_SCOPE = "admin:operations:manage"
export const ADMIN_DEBUG_ACCESS_SCOPE = "admin:debug:access"

export const OPERATOR_SCOPES = [
  BOOKING_SETTLEMENT_RESOLVE_SCOPE,
  REWARD_CAMPAIGN_INCIDENT_RESOLVE_SCOPE,
  REWARD_SETTLEMENT_READ_SCOPE,
  REWARD_REHEARSAL_EXECUTE_SCOPE,
  REWARD_SETTLEMENT_RESOLVE_SCOPE,
  STORY_SETTLEMENT_REPAIR_SCOPE,
  STORY_SETTLEMENT_FEE_REPLACE_SCOPE,
  DANCE_CHOREOGRAPHY_SEED_SCOPE,
  CONTENT_SECURITY_SCANNER_RELEASE_MANAGE_SCOPE,
  GENERIC_ASSET_EMERGENCY_CONTROLS_MANAGE_SCOPE,
  ADMIN_USERS_ACT_AS_SCOPE,
  ADMIN_USERS_MANAGE_SCOPE,
  ADMIN_OPERATIONS_MANAGE_SCOPE,
  ADMIN_DEBUG_ACCESS_SCOPE,
] as const

export type OperatorScope = (typeof OPERATOR_SCOPES)[number]

export const ALLOWED_OPERATOR_SCOPES: ReadonlySet<string> = new Set(OPERATOR_SCOPES)
