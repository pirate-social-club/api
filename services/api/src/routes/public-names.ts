import { Hono } from "hono"
import type { Env } from "../env"
import { badRequestError } from "../lib/errors"
import { getControlPlaneClient } from "../lib/runtime-deps"
import { enforcePublicNameQuoteRateLimit } from "../lib/public-names/public-name-rate-limit"
import {
  claimPublicPirateName,
  createPublicPirateNameQuote,
  getPublicPirateNameStatus,
  normalizeBuyerWalletAddress,
  normalizePublicPirateNameLabel,
} from "../lib/public-names/public-name-service"

const publicNames = new Hono<{ Bindings: Env }>()

publicNames.post("/quotes", async (c) => {
  const body = await c.req.json<{
    desired_label?: unknown
    buyer_wallet_address?: unknown
  }>().catch(() => null)
  if (!body || typeof body !== "object") {
    throw badRequestError("Invalid public pirate name quote payload")
  }
  if (typeof body.desired_label !== "string") {
    throw badRequestError("desired_label is required")
  }
  if (typeof body.buyer_wallet_address !== "string") {
    throw badRequestError("buyer_wallet_address is required")
  }
  const buyerWalletAddress = normalizeBuyerWalletAddress(body.buyer_wallet_address)
  normalizePublicPirateNameLabel(body.desired_label)

  await enforcePublicNameQuoteRateLimit({
    env: c.env,
    headers: c.req.header(),
    buyerWalletAddress,
  })

  const quote = await createPublicPirateNameQuote({
    env: c.env,
    client: getControlPlaneClient(c.env),
    desiredLabel: body.desired_label,
    buyerWalletAddress,
  })
  return c.json(quote)
})

publicNames.post("/claims", async (c) => {
  const body = await c.req.json<{
    quote?: unknown
    funding_tx_ref?: unknown
  }>().catch(() => null)
  if (!body || typeof body !== "object") {
    throw badRequestError("Invalid public pirate name claim payload")
  }
  if (typeof body.quote !== "string") {
    throw badRequestError("quote is required")
  }
  if (typeof body.funding_tx_ref !== "string") {
    throw badRequestError("funding_tx_ref is required")
  }

  const registration = await claimPublicPirateName({
    env: c.env,
    client: getControlPlaneClient(c.env),
    quote: body.quote,
    fundingTxRef: body.funding_tx_ref,
  })
  return c.json(registration)
})

publicNames.get("/:label/status", async (c) => {
  const status = await getPublicPirateNameStatus({
    client: getControlPlaneClient(c.env),
    label: c.req.param("label"),
  })
  return c.json(status, 200, {
    "cache-control": "public, max-age=30",
  })
})

export default publicNames
