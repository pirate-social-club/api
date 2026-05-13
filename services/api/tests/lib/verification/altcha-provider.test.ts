import { describe, expect, test } from "bun:test"
import { readAltchaProof } from "../../../src/lib/verification/altcha-provider"

describe("readAltchaProof", () => {
  test("prefers header value over body altcha", () => {
    const result = readAltchaProof({
      headerValue: "header-payload",
      body: { altcha: "body-payload" },
      scope: "community_join",
      action: "community:cmt_test",
    })
    expect(result).toEqual({
      payload: "header-payload",
      scope: "community_join",
      action: "community:cmt_test",
    })
  })

  test("falls back to body altcha when header is missing", () => {
    const result = readAltchaProof({
      headerValue: null,
      body: { altcha: "body-payload" },
      scope: "post_create",
      action: "community:cmt_test",
    })
    expect(result).toEqual({
      payload: "body-payload",
      scope: "post_create",
      action: "community:cmt_test",
    })
  })

  test("falls back to body altcha when header is empty", () => {
    const result = readAltchaProof({
      headerValue: "   ",
      body: { altcha: "body-payload" },
      scope: "comment_create",
      action: "post:post_test",
    })
    expect(result).toEqual({
      payload: "body-payload",
      scope: "comment_create",
      action: "post:post_test",
    })
  })

  test("returns undefined when both header and body are missing", () => {
    const result = readAltchaProof({
      headerValue: null,
      body: {},
      scope: "community_join",
      action: "community:cmt_test",
    })
    expect(result).toBe(undefined)
  })

  test("returns undefined when body is not an object", () => {
    const result = readAltchaProof({
      headerValue: null,
      body: "not-an-object",
      scope: "community_join",
      action: "community:cmt_test",
    })
    expect(result).toBe(undefined)
  })

  test("returns undefined when body is an array", () => {
    const result = readAltchaProof({
      headerValue: null,
      body: ["altcha"],
      scope: "community_join",
      action: "community:cmt_test",
    })
    expect(result).toBe(undefined)
  })
})
