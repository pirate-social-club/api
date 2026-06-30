import {
  apiRoutes,
  type BookingQuote,
  type CreatePostRequest,
  type ErrorResponse,
  type LocalizedPostResponse,
  type Post,
  type ResolveBookingSettlementReviewRequest,
  type UpdatePriceRuleRequest,
} from "@pirate/api-contracts"

export const consumerRouteExamples = {
  bookingHoldQuote: apiRoutes.bookingHoldQuote("hld_test"),
  bookingHostSlots: apiRoutes.bookingHostSlots("usr_host"),
  bookingSettlementReviewResolve: apiRoutes.bookingSettlementReviewResolve("bkg_test"),
  communityPosts: apiRoutes.communityPosts("com_test"),
  post: apiRoutes.post("pst_test"),
  notificationsFeed: apiRoutes.notificationsFeed,
} satisfies Record<string, string>

export const consumerBookingReviewResolution = {
  resolution: "completed",
  expected_review_version: 1,
  note: "attendance verified",
} satisfies ResolveBookingSettlementReviewRequest

export const consumerPartialPriceRuleUpdate = {
  priority: 2,
} satisfies UpdatePriceRuleRequest

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
export type ConsumerBookingPaymentChainId = BookingQuote["payment"]["chain_id"]
