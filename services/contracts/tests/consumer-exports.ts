import {
  apiRoutes,
  type BookingQuote,
  type BookingCancellationPreview,
  type CancelBookingRequest,
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

export const consumerCancellationPreview = {
  object: "booking_cancellation_preview",
  booking_id: "bkg_test",
  cancelled_by: "booker",
  gross_cents: 5000,
  refund_cents: 5000,
  host_payout_cents: 0,
  platform_fee_cents: 0,
  previewed_at: "2026-07-10T09:00:00.000Z",
  policy_cutoff_at: "2026-07-09T10:00:00.000Z",
} satisfies BookingCancellationPreview

export const consumerLegacyCancellation = {} satisfies CancelBookingRequest
