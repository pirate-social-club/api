import {
  apiRoutes,
  type CreatePostRequest,
  type ErrorResponse,
  type LocalizedPostResponse,
  type Post,
} from "@pirate/api-contracts"

export const consumerRouteExamples = {
  communityPosts: apiRoutes.communityPosts("com_test"),
  post: apiRoutes.post("pst_test"),
  notificationsFeed: apiRoutes.notificationsFeed,
} satisfies Record<string, string>

export const consumerRequestExample = {
  idempotency_key: "idem_test",
  post_type: "text",
  identity_mode: "public",
  title: "Hello",
  body: "World",
} satisfies CreatePostRequest

export const consumerErrorExample = {
  code: "bad_request",
  message: "Invalid request",
  retryable: false,
} satisfies ErrorResponse

export type ConsumerPostId = Post["id"]
export type ConsumerLocalizedPost = LocalizedPostResponse["post"]
