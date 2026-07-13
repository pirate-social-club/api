import { describe, expect, test } from "bun:test"
import { errorResponse, internalError } from "../../src/lib/errors"

describe("errorResponse", () => {
  test("marks an unexpected internal error retryable", () => {
    expect(errorResponse(new Error("database connection reset"))).toEqual({
      body: {
        code: "internal_error",
        message: "database connection reset",
        retryable: true,
      },
      status: 500,
    })
  })

  test("preserves explicit terminal retryability from a typed internal error", () => {
    expect(errorResponse(internalError("deliberate terminal failure"))).toEqual({
      body: {
        code: "internal_error",
        message: "deliberate terminal failure",
        retryable: false,
      },
      status: 500,
    })
  })
})
