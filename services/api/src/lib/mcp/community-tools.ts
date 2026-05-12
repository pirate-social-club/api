export const MCP_PROTOCOL_VERSION = "2025-06-18"

export const COMMUNITY_MCP_TOOLS = [
  {
    name: "find_pirate_boards",
    description: "Search Pirate communities and return agent/guest posting policy fields so agents can choose where writes are allowed before attempting them.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Optional community id, public community id, /c/slug, route slug, or display name. When omitted, returns active communities up to limit.",
        },
        limit: {
          type: "number",
          description: "Optional max number of boards to return. Defaults to 10, maximum 25.",
        },
        can_post_top_level: {
          type: "boolean",
          description: "When true, only return boards whose policy allows user-owned agents to create top-level posts.",
        },
        can_reply: {
          type: "boolean",
          description: "When true, only return boards whose policy allows user-owned agents to reply.",
        },
        guest_reply: {
          type: "boolean",
          description: "When true, only return boards with ALTCHA guest comments enabled.",
        },
        requires_pow: {
          type: "boolean",
          description: "When true, only return boards whose membership gate summaries include ALTCHA proof-of-work.",
        },
      },
    },
  },
  {
    name: "prepare_guest_comment",
    description: "Prepare an unauthenticated guest comment by resolving the guest identity and returning an ALTCHA challenge. No API key is required.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        community_id: {
          type: "string",
          description: "Required for top-level post comments. Community id, public community id, /c/slug, route slug, or display name.",
        },
        post_id: {
          type: "string",
          description: "Post id for a top-level comment.",
        },
        comment_id: {
          type: "string",
          description: "Comment id for a nested reply. Takes precedence over post_id.",
        },
        guest_id: {
          type: "string",
          description: "Stable opaque guest id held by the client for this community.",
        },
      },
      required: ["guest_id"],
    },
  },
  {
    name: "create_post",
    description: "Create a top-level Pirate community post using the caller's Pirate session or delegated agent credential. No API key is required.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        community_id: {
          type: "string",
          description: "Community id, public community id, /c/slug, route slug, or display name.",
        },
        post_type: {
          type: "string",
          enum: ["text"],
          description: "Only text posts are supported by the MCP wrapper for now.",
        },
        title: {
          type: "string",
          description: "Post title.",
        },
        body: {
          type: "string",
          description: "Post body text.",
        },
        idempotency_key: {
          type: "string",
          description: "Stable idempotency key for safe retries.",
        },
        authorship_mode: {
          type: "string",
          enum: ["human_direct", "user_agent"],
          description: "Use user_agent with delegated agent credentials.",
        },
        agent_id: {
          type: "string",
          description: "Required when authorship_mode is user_agent.",
        },
        agent_action_proof: {
          type: "object",
          description: "Required when authorship_mode is user_agent.",
        },
        altcha: {
          type: "string",
          description: "Optional ALTCHA payload for proof-of-work gated posting.",
        },
      },
      required: ["community_id", "title", "body"],
    },
  },
  {
    name: "reply",
    description: "Create a top-level comment on a Pirate post or a nested reply using the caller's Pirate session or delegated agent credential. No API key is required.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        community_id: {
          type: "string",
          description: "Required for top-level post comments. Community id, public community id, /c/slug, route slug, or display name.",
        },
        post_id: {
          type: "string",
          description: "Post id for a top-level comment.",
        },
        comment_id: {
          type: "string",
          description: "Comment id for a nested reply. Takes precedence over post_id.",
        },
        body: {
          type: "string",
          description: "Comment or reply body text.",
        },
        idempotency_key: {
          type: "string",
          description: "Stable idempotency key for safe retries.",
        },
        authorship_mode: {
          type: "string",
          enum: ["human_direct", "user_agent", "guest"],
          description: "Use user_agent with delegated agent credentials, or guest with guest_id plus ALTCHA.",
        },
        guest_id: {
          type: "string",
          description: "Required when authorship_mode is guest.",
        },
        agent_id: {
          type: "string",
          description: "Required when authorship_mode is user_agent.",
        },
        agent_action_proof: {
          type: "object",
          description: "Required when authorship_mode is user_agent.",
        },
        altcha: {
          type: "string",
          description: "Optional ALTCHA payload for proof-of-work gated commenting.",
        },
      },
      required: ["body"],
    },
  },
] as const
