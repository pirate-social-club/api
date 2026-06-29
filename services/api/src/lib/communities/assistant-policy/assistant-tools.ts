import {
  getThreadWithComments,
  listUserCommentsInCommunity,
  listUserPostsInCommunity,
  searchPublishedPosts,
} from "../board-read/board-read-service"
import { decodePublicPostId, publicPostId } from "../../public-ids"
import type { Client } from "../../sql-client"
import type { CommunityAssistantAudience } from "./context-builder"
import type { CommunityAssistantPolicy } from "./service"
import {
  PROPOSE_SONG_PURCHASE_TOOL,
  buildPurchaseProposalToolResult,
  type PurchaseProposalDeps,
  type PurchaseProposalToolContext,
} from "../commerce/funding-source/purchase-proposal"

const DEFAULT_TOOL_LIMIT = 5
const MAX_TOOL_LIMIT = 10
const TOOL_POST_EXCERPT_CHARS = 360
const TOOL_THREAD_EXCERPT_CHARS = 1_000
const TOOL_ACTIVITY_EXCERPT_CHARS = 280

export const MAX_TOOL_ROUNDS = 3
export const MAX_TOOL_RESULT_CHARS = 2_000
export const MAX_TOTAL_TOOL_RESULT_CHARS = 6_000

export type CommunityAssistantToolDefinition = {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type CommunityAssistantToolName =
  | "search_board"
  | "get_thread"
  | "get_my_activity"
  | "propose_song_purchase"

// Binding that enables the propose_song_purchase tool. Supplied only when purchasing is available
// for this chat (identified user, purchasing enabled). When absent the tool is neither offered nor
// dispatchable.
export type CommunityAssistantPurchaseBinding = {
  context: PurchaseProposalToolContext
  deps: PurchaseProposalDeps
}

export type CommunityAssistantToolCall = {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export type CommunityAssistantToolExecutionInput = {
  audience: CommunityAssistantAudience
  client: Client
  communityId: string
  policy: CommunityAssistantPolicy
  toolCall: CommunityAssistantToolCall
  userId: string | null
  // Present only when purchasing is available for this chat; enables propose_song_purchase.
  purchaseProposal?: CommunityAssistantPurchaseBinding
}

// Tool definitions to offer the model. propose_song_purchase is included only when purchasing is
// enabled for the chat.
export function communityAssistantToolDefinitions(options?: {
  purchasingEnabled?: boolean
}): readonly CommunityAssistantToolDefinition[] {
  return options?.purchasingEnabled
    ? [...COMMUNITY_ASSISTANT_TOOLS, PROPOSE_SONG_PURCHASE_TOOL]
    : COMMUNITY_ASSISTANT_TOOLS
}

export const COMMUNITY_ASSISTANT_TOOLS: readonly CommunityAssistantToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "search_board",
      description: "Search this community board for relevant published threads. Use this when the user asks about a topic, old discussion, decision, recommendation, or anything not fully covered by the provided context.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description: "Short keyword query for the topic to search on the board.",
          },
          limit: {
            type: "number",
            description: "Maximum number of matching threads to return. Defaults to 5, maximum 10.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_thread",
      description: "Read one board thread and a bounded set of its top comments. Use this after search_board when a thread looks relevant and you need detail before answering.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          post_id: {
            type: "string",
            description: "Post id returned by search_board.",
          },
          comment_limit: {
            type: "number",
            description: "Maximum number of comments to return. Defaults to 5, maximum 10.",
          },
        },
        required: ["post_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_activity",
      description: "Read the current user's recent published posts and comments in this community. Use this only when the user asks about their own posts, comments, history, or activity.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: {
            type: "number",
            description: "Maximum number of recent posts and comments to return. Defaults to 5, maximum 10.",
          },
        },
      },
    },
  },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function limitFromArgs(value: unknown): number {
  const raw = typeof value === "number" ? value : Number.NaN
  if (!Number.isFinite(raw)) return DEFAULT_TOOL_LIMIT
  return Math.min(MAX_TOOL_LIMIT, Math.max(1, Math.trunc(raw)))
}

function stringArg(args: Record<string, unknown>, field: string): string {
  const value = typeof args[field] === "string" ? args[field].trim() : ""
  if (!value) {
    throw new Error(`${field} is required`)
  }
  return value
}

function parseToolArguments(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw || "{}") as unknown
  if (!isRecord(parsed)) {
    throw new Error("tool arguments must be an object")
  }
  return parsed
}

function toolVisibility(audience: CommunityAssistantAudience): "public" | null {
  return audience === "public_group" ? "public" : null
}

function clipToolResult(value: unknown, maxChars: number): string {
  const text = JSON.stringify(value) ?? ""
  if (text.length <= maxChars) {
    return text
  }
  return `${text.slice(0, Math.max(0, maxChars - 24)).trimEnd()}... [tool result truncated]`
}

export function clipAssistantToolResult(value: unknown, maxChars = MAX_TOOL_RESULT_CHARS): string {
  return clipToolResult(value, maxChars)
}

function toolError(message: string) {
  return {
    error: "tool_failed",
    message,
  }
}

export function isCommunityAssistantToolCall(value: unknown): value is CommunityAssistantToolCall {
  if (!isRecord(value)) return false
  const fn = value.function
  if (!isRecord(fn)) return false
  return (
    typeof value.id === "string"
    && value.type === "function"
    && typeof fn.name === "string"
    && typeof fn.arguments === "string"
  )
}

export async function executeCommunityAssistantTool(input: CommunityAssistantToolExecutionInput): Promise<{
  content: string
  name: string
}> {
  const name = input.toolCall.function.name as CommunityAssistantToolName
  try {
    const args = parseToolArguments(input.toolCall.function.arguments)
    const visibility = toolVisibility(input.audience)
    if (name === "search_board") {
      const query = stringArg(args, "query")
      const posts = await searchPublishedPosts(input.client, input.communityId, {
        excerptChars: TOOL_POST_EXCERPT_CHARS,
        limit: limitFromArgs(args.limit),
        query,
        since: input.policy.maxLookbackDays == null
          ? null
          : new Date(Date.now() - input.policy.maxLookbackDays * 24 * 60 * 60 * 1000).toISOString(),
        visibility,
      })
      return {
        name,
        content: clipToolResult({
          object: "assistant_tool_result",
          tool: name,
          query,
          posts: posts.map((post) => ({
            post_id: publicPostId(post.postId),
            title: post.title,
            post_type: post.postType,
            body_excerpt: post.bodyExcerpt,
            caption_excerpt: post.captionExcerpt,
            comment_count: post.commentCount,
            created_at: post.createdAt,
            score: post.score,
          })),
        }, MAX_TOOL_RESULT_CHARS),
      }
    }

    if (name === "get_thread") {
      const postId = decodePublicPostId(stringArg(args, "post_id"))
      const thread = await getThreadWithComments(input.client, postId, {
        commentLimit: limitFromArgs(args.comment_limit),
        excerptChars: TOOL_THREAD_EXCERPT_CHARS,
        visibility,
      })
      if (!thread || thread.post.communityId !== input.communityId) {
        throw new Error("post_id was not found")
      }
      return {
        name,
        content: clipToolResult({
          object: "assistant_tool_result",
          tool: name,
          thread: {
            post: {
              post_id: publicPostId(thread.post.postId),
              title: thread.post.title,
              post_type: thread.post.postType,
              body_excerpt: thread.post.bodyExcerpt,
              caption_excerpt: thread.post.captionExcerpt,
              comment_count: thread.post.commentCount,
              created_at: thread.post.createdAt,
            },
            comments: thread.comments.map((comment) => ({
              body_excerpt: comment.bodyExcerpt,
              created_at: comment.createdAt,
              score: comment.score,
            })),
          },
        }, MAX_TOOL_RESULT_CHARS),
      }
    }

    if (name === "get_my_activity") {
      if (input.audience !== "private_user" || !input.userId) {
        throw new Error("get_my_activity is only available in private user chats")
      }
      const limit = limitFromArgs(args.limit)
      const [posts, comments] = await Promise.all([
        listUserPostsInCommunity(input.client, input.communityId, input.userId, {
          excerptChars: TOOL_ACTIVITY_EXCERPT_CHARS,
          limit,
        }),
        listUserCommentsInCommunity(input.client, input.communityId, input.userId, {
          excerptChars: TOOL_ACTIVITY_EXCERPT_CHARS,
          limit,
        }),
      ])
      return {
        name,
        content: clipToolResult({
          object: "assistant_tool_result",
          tool: name,
          posts: posts.map((post) => ({
            post_id: publicPostId(post.postId),
            title: post.title,
            post_type: post.postType,
            body_excerpt: post.bodyExcerpt,
            caption_excerpt: post.captionExcerpt,
            comment_count: post.commentCount,
            created_at: post.createdAt,
          })),
          comments: comments.map((comment) => ({
            thread_root_post: publicPostId(comment.threadRootPostId),
            thread_title: comment.threadTitle,
            body_excerpt: comment.bodyExcerpt,
            created_at: comment.createdAt,
            score: comment.score,
          })),
        }, MAX_TOOL_RESULT_CHARS),
      }
    }

    if (name === "propose_song_purchase") {
      if (!input.purchaseProposal) {
        throw new Error("Purchasing is not available in this chat")
      }
      return {
        name,
        content: clipToolResult(
          await buildPurchaseProposalToolResult(
            args,
            input.purchaseProposal.context,
            input.purchaseProposal.deps,
          ),
          MAX_TOOL_RESULT_CHARS,
        ),
      }
    }

    throw new Error(`Unknown tool: ${input.toolCall.function.name}`)
  } catch (error) {
    return {
      name: input.toolCall.function.name,
      content: clipToolResult(toolError(error instanceof Error ? error.message : "Tool execution failed"), MAX_TOOL_RESULT_CHARS),
    }
  }
}
