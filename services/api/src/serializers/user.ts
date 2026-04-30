import type { User as ContractUser } from "@pirate/api-contracts"
import type { User } from "../types"
import { nullableUnixSeconds, unixSeconds } from "./time"

export function serializeUser(user: User): ContractUser {
  return {
    id: `usr_${user.user_id}`,
    object: "user",
    community_posting_state: user.community_posting_state
      ? {
        community_ref: user.community_posting_state.community_ref,
        community: user.community_posting_state.community_id ? `com_${user.community_posting_state.community_id}` : undefined,
        has_created_text_post: user.community_posting_state.has_created_text_post,
      }
      : user.community_posting_state,
    primary_wallet_attachment: user.primary_wallet_attachment_id,
    verification_state: user.verification_state,
    capability_provider: user.capability_provider,
    verification_capabilities: user.verification_capabilities,
    verified_at: nullableUnixSeconds(user.verified_at),
    created: unixSeconds(user.created_at),
  }
}
