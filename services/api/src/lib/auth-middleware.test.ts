import { describe, expect, test } from "bun:test"
import type { Env } from "../env"
import { authenticateAdminUserOrAgentDelegated, requireBearerToken } from "./auth-middleware"
import { AuthenticationFailureError, HttpError } from "./errors"

describe("authentication error classification", () => {
  test("classifies invalid bearer input as an authentication failure", () => {
    expect(() => requireBearerToken(undefined)).toThrow(AuthenticationFailureError)
  })

  test("does not retry operational user-auth failures as delegated credentials", async () => {
    await expect(authenticateAdminUserOrAgentDelegated({
      allowAgentDelegated: true,
      authorization: "Bearer invalid-token",
      env: {} as Env,
      xAdminAsUserId: undefined,
      xAdminToken: undefined,
    })).rejects.toMatchObject({
      status: 500,
      code: "internal_error",
    } satisfies Partial<HttpError>)
  })
})
