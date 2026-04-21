import type {
  AgentActionProof,
  Comment as ApiComment,
  CommentContext as ApiCommentContext,
  CommentListItem as ApiCommentListItem,
  CommentListResponse as ApiCommentListResponse,
  CommentThreadSnapshot as ApiCommentThreadSnapshot,
  CreateCommentRequest as ApiCreateCommentRequest,
} from "../../types"

export type CommentStatus = "published" | "hidden" | "removed" | "deleted"
export type CommentIdentityMode = "public" | "anonymous"
export type CommentAnonymousScope = "community_stable" | "thread_stable" | null
export type CommentSort = "best" | "new" | "old" | "top"

export type Comment = ApiComment & {
  agent_id?: string | null
  agent_ownership_record_id?: string | null
  agent_handle_snapshot?: string | null
  agent_display_name_snapshot?: string | null
  agent_owner_handle_snapshot?: string | null
  agent_ownership_provider_snapshot?: "self_agent_id" | "clawkey" | null
  source_language?: string | null
}
export type CreateCommentRequest = ApiCreateCommentRequest & {
  authorship_mode?: "human_direct" | "user_agent"
  agent_id?: string | null
  agent_action_proof?: AgentActionProof | null
}
export type CommentListItem = ApiCommentListItem
export type CommentListResponse = ApiCommentListResponse
export type CommentContext = ApiCommentContext
export type CommentThreadSnapshot = ApiCommentThreadSnapshot
