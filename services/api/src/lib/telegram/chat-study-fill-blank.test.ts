import { describe, expect, test } from "bun:test"
import { __telegramStudyFillBlankTestHooks as hooks } from "./chat-study-service"

const exercise = {
  first_outcome: null,
  id: "stu:unit_1:fill_blank:en",
  line_id: "line_001",
  line_index: 0,
  mastered: false,
  max_attempts: 3,
  presentation_count: 0,
  prompt_text: "Fill in the lyric.",
  segments: [
    { kind: "text" as const, text: "We " },
    { id: "blank_1", kind: "blank" as const },
    { kind: "text" as const, text: " and " },
    { id: "blank_2", kind: "blank" as const },
  ],
  tokens: [
    { id: "token_1", text: "sing" },
    { id: "token_2", text: "dance" },
    { id: "token_3", text: "wait" },
  ],
  type: "fill_blank" as const,
}

describe("Telegram fill-blank controls", () => {
  test("selects, undoes, clears, and enables submit only when complete", () => {
    const payload = hooks.fillBlankPayload({
      attemptNumber: 1,
      exercise,
      sessionId: "session_1",
      sessionRevision: 3,
      shared: {},
    })
    expect(hooks.fillBlankMarkup(payload, "action_1").inline_keyboard.flat()
      .some((button) => button.callback_data.endsWith(`:${hooks.submitIndex}`))).toBe(false)

    const one = hooks.updatedFillBlankSelection(payload, 0)
    const twoPayload = { ...payload, selectedTokenIds: one }
    const two = hooks.updatedFillBlankSelection(twoPayload, 1)
    const completePayload = { ...payload, selectedTokenIds: two }
    expect(hooks.fillBlankText(completePayload)).toBe("We 【sing】 and 【dance】")
    expect(hooks.fillBlankPlacements(completePayload)).toEqual([
      { blank_id: "blank_1", token_id: "token_1" },
      { blank_id: "blank_2", token_id: "token_2" },
    ])
    expect(hooks.fillBlankMarkup(completePayload, "action_2").inline_keyboard.flat()
      .some((button) => button.callback_data.endsWith(`:${hooks.submitIndex}`))).toBe(true)
    expect(hooks.updatedFillBlankSelection(completePayload, hooks.undoIndex)).toEqual(["token_1"])
    expect(hooks.updatedFillBlankSelection(completePayload, hooks.clearIndex)).toEqual([])
  })

  test("rejects a token bank that overlaps the reserved callback indexes", () => {
    expect(() => hooks.fillBlankPayload({
      attemptNumber: 1,
      exercise: {
        ...exercise,
        tokens: Array.from({ length: hooks.undoIndex }, (_, index) => ({
          id: `token_${index}`,
          text: `word ${index}`,
        })),
      },
      sessionId: "session_1",
      sessionRevision: 3,
      shared: {},
    })).toThrow("Telegram callback capacity")
  })

  test("preserves valid in-progress selections when a prompt is resent", () => {
    const refreshed = hooks.refreshedFillBlankPayload({
      attemptNumber: 2,
      exercise,
      existing: { selectedTokenIds: ["token_1", "stale_token"] },
      progressLabel: "2/6",
      sessionId: "session_1",
      sessionRevision: 4,
    })

    expect(refreshed.selectedTokenIds).toEqual(["token_1"])
    expect(refreshed.sessionRevision).toBe(4)
    expect(hooks.fillBlankText(refreshed)).toBe("We 【sing】 and 【2】")
  })
})
