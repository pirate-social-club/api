import { Hono } from "hono"
import { getJob } from "../lib/communities/membership/job-service"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"
import { decodePublicJobId } from "../lib/public-ids"

const jobs = new Hono<AuthenticatedEnv>()

jobs.use("*", authenticate)

jobs.get("/:jobId", async (c) => {
  const actor = c.get("actor")
  const repository = getCommunityRepository(c.env)
  const result = await getJob({
    env: c.env,
    userId: actor.userId,
    jobId: decodePublicJobId(c.req.param("jobId")),
    repository,
  })
  return c.json(result, 200)
})

export default jobs
