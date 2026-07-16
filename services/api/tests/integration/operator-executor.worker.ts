export { OperatorSigningCoordinatorDO } from "../../src/lib/communities/bookings/operator-signing-coordinator-do"
export { CommentCreateRateLimiterDO } from "../../src/lib/comment-create-rate-limit"

export default {
  fetch(): Response {
    return new Response("Not Found", { status: 404 })
  },
}
