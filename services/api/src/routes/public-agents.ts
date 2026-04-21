import { Hono } from "hono"
import { notFoundError } from "../lib/errors"
import { getControlPlaneAgentOwnershipRepository } from "../lib/agents/control-plane-agent-ownership-repository"
import type { Env } from "../types"

const publicAgents = new Hono<{ Bindings: Env }>()

publicAgents.get("/:handleLabel", async (c) => {
  const repository = getControlPlaneAgentOwnershipRepository(c.env)
  const resolved = await repository.resolvePublicAgentByHandle(c.req.param("handleLabel"))
  if (!resolved) {
    throw notFoundError("Agent not found")
  }
  return c.json(resolved, 200)
})

export default publicAgents
