import { Hono } from "hono"
import { getJob } from "../lib/communities/community-service"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"

const jobs = new Hono<AuthenticatedEnv>()

jobs.use("*", authenticate)

jobs.get("/:jobId", async (c) => {
  const actor = c.get("actor")
  const repository = getCommunityRepository(c.env)
  const result = await getJob({
    env: c.env,
    userId: actor.userId,
    jobId: c.req.param("jobId"),
    repository,
  })
  return c.json(result, 200)
})

export default jobs
