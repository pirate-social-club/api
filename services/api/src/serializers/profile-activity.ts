import type {
  ProfileActivityCommentPage as ContractProfileActivityCommentPage,
  ProfileActivityPostPage as ContractProfileActivityPostPage,
  ProfileActivityResponse as ContractProfileActivityResponse,
} from "@pirate/api-contracts"
import type {
  ProfileActivityCommentPage,
  ProfileActivityPostPage,
  ProfileActivityResponse,
} from "../types"
import { serializeCommentListItem } from "./comment"
import { serializeCommunityPreview } from "./community"
import { serializeLocalizedPostResponse } from "./post"
import { unixSeconds } from "./time"

function serializeProfileActivityPostPage(item: ProfileActivityPostPage): ContractProfileActivityPostPage {
  return {
    kind: "post",
    post: serializeLocalizedPostResponse(item.post),
    community: serializeCommunityPreview(item.community),
    created: unixSeconds(item.created_at),
  }
}

function serializeProfileActivityCommentPage(item: ProfileActivityCommentPage): ContractProfileActivityCommentPage {
  return {
    kind: "comment",
    comment: serializeCommentListItem(item.comment),
    thread_root_post: serializeLocalizedPostResponse(item.thread_root_post),
    community: serializeCommunityPreview(item.community),
    created: unixSeconds(item.created_at),
  }
}

export function serializeProfileActivityResponse(response: ProfileActivityResponse): ContractProfileActivityResponse {
  return {
    tab: response.tab,
    posts: response.posts.map(serializeProfileActivityPostPage),
    comments: response.comments.map(serializeProfileActivityCommentPage),
    overview_items: response.overview_items.map((item) => (
      item.kind === "post"
        ? serializeProfileActivityPostPage(item)
        : serializeProfileActivityCommentPage(item)
    )),
    next_cursor: response.next_cursor,
  }
}
