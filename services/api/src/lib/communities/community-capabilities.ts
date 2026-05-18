import { publicCommunityId } from "../public-ids"
import type { CommunityPreview } from "../../types"

type CapabilityDecision = {
  allowed: boolean
  blocked_reason: string | null
  hint: string | null
  requires: string[]
}

export type CommunityActionMatrix = {
  community: string
  display_name: string
  route_slug: string | null
  read: {
    public_community: CapabilityDecision
    public_threads: CapabilityDecision
    public_posts: CapabilityDecision
    public_comments: CapabilityDecision
  }
  write: {
    guest_comment: CapabilityDecision & {
      authorship_mode: "guest"
    }
    guest_top_level_post: CapabilityDecision & {
      authorship_mode: "guest"
    }
    delegated_agent_reply: CapabilityDecision & {
      accepted_ownership_providers: string[]
      authorship_mode: "user_agent"
    }
    delegated_agent_top_level_post: CapabilityDecision & {
      accepted_ownership_providers: string[]
      authorship_mode: "user_agent"
    }
    user_join: CapabilityDecision & {
      auth: "user_bearer"
    }
    user_vote: CapabilityDecision & {
      auth: "user_bearer"
    }
  }
  raw_policy: {
    agent_daily_post_cap: number | null
    agent_daily_reply_cap: number | null
    agent_posting_policy: CommunityPreview["agent_posting_policy"]
    agent_posting_scope: CommunityPreview["agent_posting_scope"]
    allow_anonymous_identity: boolean
    accepted_agent_ownership_providers: NonNullable<CommunityPreview["accepted_agent_ownership_providers"]>
    guest_comment_policy: CommunityPreview["guest_comment_policy"]
    membership_gate_summaries: CommunityPreview["membership_gate_summaries"]
    membership_mode: CommunityPreview["membership_mode"]
  }
}

function allowedDecision(requires: string[] = [], hint: string | null = null): CapabilityDecision {
  return {
    allowed: true,
    blocked_reason: null,
    hint,
    requires,
  }
}

function blockedDecision(blockedReason: string, hint: string | null = null, requires: string[] = []): CapabilityDecision {
  return {
    allowed: false,
    blocked_reason: blockedReason,
    hint,
    requires,
  }
}

function hasAltchaGate(preview: CommunityPreview): boolean {
  return preview.membership_gate_summaries.some((summary) => summary.gate_type === "altcha_pow")
}

export function buildCommunityActionMatrix(preview: CommunityPreview): CommunityActionMatrix {
  const acceptedProviders = preview.accepted_agent_ownership_providers ?? []
  const agentPolicyAllowsWrites = preview.agent_posting_policy !== "disallow"
  const agentProviderRequired = acceptedProviders.length === 0
  const proofRequirements = hasAltchaGate(preview) ? ["altcha"] : []

  const delegatedAgentReply = agentPolicyAllowsWrites
    ? agentProviderRequired
      ? blockedDecision(
          "agent_ownership_provider_not_configured",
          "Community agent writes are enabled, but no accepted ownership providers are configured.",
        )
      : allowedDecision(proofRequirements, "Use MCP reply with authorship_mode user_agent and agent_action_proof.")
    : blockedDecision("agent_posting_disallowed", "Use guest comments if enabled, or ask for a normal user Bearer token.")

  const delegatedAgentTopLevelPost = agentPolicyAllowsWrites
    ? preview.agent_posting_scope === "top_level_and_replies"
      ? agentProviderRequired
        ? blockedDecision(
            "agent_ownership_provider_not_configured",
            "Community agent writes are enabled, but no accepted ownership providers are configured.",
          )
        : allowedDecision(proofRequirements, "Use MCP create_post with authorship_mode user_agent and agent_action_proof.")
      : blockedDecision("agent_top_level_posts_disallowed", "This community allows delegated-agent replies only.")
    : blockedDecision("agent_posting_disallowed", "Use guest comments if enabled, or ask for a normal user Bearer token.")

  return {
    community: publicCommunityId(preview.community_id),
    display_name: preview.display_name,
    route_slug: preview.route_slug ?? null,
    read: {
      public_community: allowedDecision([], "Read the public preview with /public-communities/{community_id}."),
      public_threads: allowedDecision([], "List public threads with /public-communities/{community_id}/posts."),
      public_posts: allowedDecision([], "Read a public post with /public-posts/{post_id}."),
      public_comments: allowedDecision([], "Read comments with /public-posts/{post_id}/top-comments or /thread."),
    },
    write: {
      guest_comment: preview.guest_comment_policy === "altcha_required"
        ? {
            ...allowedDecision(["altcha"], "Use MCP prepare_guest_comment, solve ALTCHA, then MCP reply with authorship_mode guest."),
            authorship_mode: "guest",
          }
        : {
            ...blockedDecision("guest_comments_disallowed", "This community does not allow unauthenticated guest comments."),
            authorship_mode: "guest",
          },
      guest_top_level_post: {
        ...blockedDecision("guest_top_level_posts_not_supported", "Guest mode only supports comments and replies."),
        authorship_mode: "guest",
      },
      delegated_agent_reply: {
        ...delegatedAgentReply,
        accepted_ownership_providers: acceptedProviders,
        authorship_mode: "user_agent",
      },
      delegated_agent_top_level_post: {
        ...delegatedAgentTopLevelPost,
        accepted_ownership_providers: acceptedProviders,
        authorship_mode: "user_agent",
      },
      user_join: {
        ...allowedDecision(proofRequirements, "Use a normal Pirate user Bearer token. Do not use delegated-agent credentials."),
        auth: "user_bearer",
      },
      user_vote: {
        ...allowedDecision([], "Use a normal Pirate user Bearer token."),
        auth: "user_bearer",
      },
    },
    raw_policy: {
      agent_daily_post_cap: preview.agent_daily_post_cap ?? null,
      agent_daily_reply_cap: preview.agent_daily_reply_cap ?? null,
      agent_posting_policy: preview.agent_posting_policy,
      agent_posting_scope: preview.agent_posting_scope,
      allow_anonymous_identity: preview.allow_anonymous_identity ?? false,
      accepted_agent_ownership_providers: acceptedProviders,
      guest_comment_policy: preview.guest_comment_policy,
      membership_gate_summaries: preview.membership_gate_summaries,
      membership_mode: preview.membership_mode,
    },
  }
}
