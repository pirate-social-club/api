import type {
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
  source_language?: string | null
}
export type CreateCommentRequest = ApiCreateCommentRequest
export type CommentListItem = ApiCommentListItem
export type CommentListResponse = ApiCommentListResponse
export type CommentContext = ApiCommentContext
export type CommentThreadSnapshot = ApiCommentThreadSnapshot
