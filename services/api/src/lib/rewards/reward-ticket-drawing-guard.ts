export type RewardTicketDrawingCheckStage = "before_submit" | "receipt"

export type RewardTicketDrawingAssociation =
  | {
      status: "matched"
      drawingId: string
    }
  | {
      status: "needs_review"
      reason: "drawing_rolled_over" | "receipt_drawing_id_mismatch" | "invalid_drawing_id"
      expectedDrawingId: string
      observedDrawingId: string
    }

function normalizeDrawingId(value: string | bigint): string {
  if (typeof value === "bigint") {
    if (value < 0n) throw new Error("drawing id must be non-negative")
    return value.toString()
  }
  if (!/^[0-9]+$/u.test(value)) throw new Error("drawing id must be a decimal integer")
  return BigInt(value).toString()
}

/**
 * Check the association at both sides of the chain boundary:
 *
 * - before_submit prevents buying after Megapot has rolled to another drawing;
 * - receipt prevents a successful transaction from being marked confirmed if
 *   the protocol associated it with a different drawing.
 *
 * A mismatch is data for the needs_review state, never a successful purchase.
 */
export function evaluateRewardTicketDrawingAssociation(input: {
  expectedDrawingId: string | bigint
  observedDrawingId: string | bigint
  stage: RewardTicketDrawingCheckStage
}): RewardTicketDrawingAssociation {
  const expectedRaw = String(input.expectedDrawingId)
  const observedRaw = String(input.observedDrawingId)
  try {
    const expected = normalizeDrawingId(input.expectedDrawingId)
    const observed = normalizeDrawingId(input.observedDrawingId)
    if (expected === observed) return { status: "matched", drawingId: expected }
    return {
      status: "needs_review",
      reason: input.stage === "before_submit"
        ? "drawing_rolled_over"
        : "receipt_drawing_id_mismatch",
      expectedDrawingId: expected,
      observedDrawingId: observed,
    }
  } catch {
    return {
      status: "needs_review",
      reason: "invalid_drawing_id",
      expectedDrawingId: expectedRaw,
      observedDrawingId: observedRaw,
    }
  }
}
