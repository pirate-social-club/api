import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"

import { buildRewardVaultLitAction } from "./reward-vault-lit-action"
import {
  PINNED_REWARD_VAULT_ACTION_CID,
  PINNED_REWARD_VAULT_ACTION_ERROR_TOKENS,
  PINNED_REWARD_VAULT_ACTION_SHA256,
  pinnedRewardVaultActionErrorToken,
} from "./reward-vault-lit-action-errors"

const PINNED_SOURCE = buildRewardVaultLitAction({
  vaultAddress: "0x01c84e513CC823255A9651885Fb59E363B47d55a",
  signerAddress: "0x6a1C1a6C780E9F2eb23E564C04B6316864468c46",
  chainId: 84532,
  policyVersion: 1n,
  maxDeadlineSeconds: 7200,
  maxFeePerGasWei: 50_000_000_000n,
  maxPriorityFeePerGasWei: 25_000_000_000n,
  maxGasLimit: 300_000n,
})

describe("pinnedRewardVaultActionErrorToken", () => {
  test("is tied to the registered action bytes and CID", () => {
    expect(PINNED_REWARD_VAULT_ACTION_CID)
      .toBe("QmR9EqhLEK7jE1wp44wLanmeJwK3Wr3kPtsfD4pjAmogm7")
    expect(createHash("sha256").update(PINNED_SOURCE).digest("hex"))
      .toBe(PINNED_REWARD_VAULT_ACTION_SHA256)
  })

  test("covers every throw-new-Error literal and dynamic expansion in the pinned source", () => {
    const staticMessages = Array.from(PINNED_SOURCE.matchAll(
      /throw new Error\("([^"]+)"\)/gu,
    ), (match) => match[1])
    expect(new Set(staticMessages)).toEqual(new Set([
      "request is required",
      "chainId does not match pinned policy",
      "policyVersion does not match pinned policy",
      "method is not permitted",
      "operationId must be bytes32",
      "deadline is outside pinned policy",
      "nonce must be a non-negative safe integer",
      "gas policy is required",
      "gas fields exceed pinned policy",
      "PKP signer does not match pinned policy",
    ]))
    for (const message of staticMessages) {
      expect(Object.hasOwn(PINNED_REWARD_VAULT_ACTION_ERROR_TOKENS, message)).toBe(true)
    }

    expect(PINNED_SOURCE.match(/throw new Error\(/gu)).toHaveLength(13)
    expect(PINNED_SOURCE).toContain('throw new Error(field + " must be a canonical positive integer")')
    expect(PINNED_SOURCE).toContain('throw new Error(field + " is invalid")')
    expect(PINNED_SOURCE).toContain('throw new Error(field + " does not match pinned policy")')
    expect(Object.keys(PINNED_REWARD_VAULT_ACTION_ERROR_TOKENS)).toHaveLength(19)
    for (const field of ["amount", "deadline", "maxFeePerGas", "maxPriorityFeePerGas", "gasLimit"]) {
      expect(Object.hasOwn(PINNED_REWARD_VAULT_ACTION_ERROR_TOKENS,
        `${field} must be a canonical positive integer`,
      )).toBe(true)
    }
    for (const field of ["vaultAddress", "signerAddress"]) {
      expect(Object.hasOwn(PINNED_REWARD_VAULT_ACTION_ERROR_TOKENS, `${field} is invalid`)).toBe(true)
      expect(Object.hasOwn(PINNED_REWARD_VAULT_ACTION_ERROR_TOKENS,
        `${field} does not match pinned policy`,
      )).toBe(true)
    }
  })

  test.each(Object.entries(PINNED_REWARD_VAULT_ACTION_ERROR_TOKENS))(
    "maps the frozen message %s to %s through an arbitrary JSON envelope",
    (message, token) => {
      expect(pinnedRewardVaultActionErrorToken({
        provider: {
          execution: [`Uncaught Error: ${message}\n  at main (file:///user_provided_script.js:1:1)`],
        },
      })).toBe(token)
    },
  )

  test("maps the two rehearsal policy failures to distinct tokens", () => {
    expect(pinnedRewardVaultActionErrorToken(
      "Uncaught Error: deadline is outside pinned policy\n  at main (action.js:55:11)",
    )).toBe("deadline_out_of_policy")
    expect(pinnedRewardVaultActionErrorToken(
      "Uncaught Error: policyVersion does not match pinned policy\n  at main (action.js:42:11)",
    )).toBe("policy_version_mismatch")
  })

  test("returns null for unknown messages without exposing provider content", () => {
    const unknown = "provider-secret-must-not-be-persisted"
    expect(pinnedRewardVaultActionErrorToken({
      unknown: `Uncaught Error: ${unknown}\n  at main (action.js:1:1)`,
    })).toBeNull()
  })
})
