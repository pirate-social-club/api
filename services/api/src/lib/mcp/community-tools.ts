export const MCP_PROTOCOL_VERSION = "2025-06-18"

export const COMMUNITY_MCP_TOOLS = [
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
          description: "Optional ALTCHA payload for proof-of-work gated commenting.",
        },
      },
      required: ["body"],
    },
  },
] as const
