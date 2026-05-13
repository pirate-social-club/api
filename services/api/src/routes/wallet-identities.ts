import { Hono } from "hono"
import type { Env } from "../env"
import { getProfileRepository } from "../lib/auth/repositories"
import { getControlPlaneClient } from "../lib/runtime-deps"
import {
  normalizeWalletIdentityInput,
  resolveWalletIdentity,
} from "../lib/wallet-identities/wallet-identity-service"

const walletIdentities = new Hono<{ Bindings: Env }>()

walletIdentities.get("/:chainRef/:walletAddress", async (c) => {
  const normalized = normalizeWalletIdentityInput({
    chainRef: c.req.param("chainRef"),
    walletAddress: c.req.param("walletAddress"),
  })
  const profileResolution = await getProfileRepository(c.env).resolvePublicProfileByWalletAddress(normalized.walletAddress)
  const identity = await resolveWalletIdentity({
    client: getControlPlaneClient(c.env),
    chainRef: normalized.chainRef,
    walletAddress: normalized.walletAddress,
    profileResolution,
  })
  return c.json(identity, 200, {
    "cache-control": "public, max-age=30",
  })
})

export default walletIdentities
