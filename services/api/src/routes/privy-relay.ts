import { Hono } from "hono"
import type { Address, Hex } from "viem"

import { normalizeAddress } from "@pirate/efp-shared"
import { authenticateAdminOrUser, type AuthenticatedEnv } from "../lib/auth-middleware"
import { badRequestError } from "../lib/errors"
import {
  relaySponsoredFollowTransaction,
  type FollowRelayRequest,
} from "../lib/efp-indexer/follow-sponsorship-relay"
import { getControlPlaneClient } from "../lib/runtime-deps"

const privyRelay = new Hono<AuthenticatedEnv>()
privyRelay.use("*", authenticateAdminOrUser)

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw badRequestError(`${label} is required`)
  return value.trim()
}

privyRelay.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null)
  if (!body) throw badRequestError("Invalid Privy relay request")
  const transaction = body.transaction
  if (!transaction || typeof transaction !== "object") {
    throw badRequestError("transaction is required")
  }
  const tx = transaction as Record<string, unknown>
  const walletAddress = normalizeAddress(requiredString(body.walletAddress, "walletAddress"))
  const to = normalizeAddress(requiredString(tx.to, "transaction.to"))
  const data = requiredString(tx.data, "transaction.data")
  if (!walletAddress || !to || !/^0x[0-9a-f]*$/iu.test(data)) {
    throw badRequestError("Invalid relay transaction")
  }
  const request: FollowRelayRequest = {
    authorizationSignature: requiredString(body.authorizationSignature, "authorizationSignature"),
    intentId: requiredString(body.intentId, "intentId"),
    transactionIndex: Number(body.transactionIndex),
    privyWalletId: requiredString(body.privyWalletId, "privyWalletId"),
    walletAddress,
    transaction: {
      data: data as Hex,
      to: to as Address,
      ...(typeof tx.value === "string" ? { value: tx.value } : {}),
    },
  }
  const result = await relaySponsoredFollowTransaction({
    actorUserId: c.get("actor").userId,
    client: getControlPlaneClient(c.env),
    env: c.env,
    request,
  })
  return c.json(result, 202)
})

export default privyRelay
