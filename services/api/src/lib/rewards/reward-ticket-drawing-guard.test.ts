import { describe, expect, test } from "bun:test"

import { evaluateRewardTicketDrawingAssociation } from "./reward-ticket-drawing-guard"

describe("reward ticket drawing association guard", () => {
  test("accepts the same drawing at the pre-submit boundary", () => {
    expect(evaluateRewardTicketDrawingAssociation({
      expectedDrawingId: "000141",
      observedDrawingId: 141n,
      stage: "before_submit",
    })).toEqual({ status: "matched", drawingId: "141" })
  })

  test("routes a chain rollover before submission to needs_review", () => {
    expect(evaluateRewardTicketDrawingAssociation({
      expectedDrawingId: "141",
      observedDrawingId: "142",
      stage: "before_submit",
    })).toEqual({
      status: "needs_review",
      reason: "drawing_rolled_over",
      expectedDrawingId: "141",
      observedDrawingId: "142",
    })
  })

  test("routes a receipt associated with another drawing to needs_review", () => {
    expect(evaluateRewardTicketDrawingAssociation({
      expectedDrawingId: 141n,
      observedDrawingId: "142",
      stage: "receipt",
    })).toEqual({
      status: "needs_review",
      reason: "receipt_drawing_id_mismatch",
      expectedDrawingId: "141",
      observedDrawingId: "142",
    })
  })

  test("does not treat malformed chain data as a confirmed purchase", () => {
    expect(evaluateRewardTicketDrawingAssociation({
      expectedDrawingId: "141",
      observedDrawingId: "not-a-drawing",
      stage: "receipt",
    })).toEqual({
      status: "needs_review",
      reason: "invalid_drawing_id",
      expectedDrawingId: "141",
      observedDrawingId: "not-a-drawing",
    })
  })
})
