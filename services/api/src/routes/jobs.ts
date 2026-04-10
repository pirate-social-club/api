import { Hono } from "hono"
import { getJob } from "../lib/communities/community-service"
import { getControlPlaneCommunityRepository } from "../lib/communities/control-plane-community-repository"
import { errorResponse } from "../lib/errors"
import { requireBearerToken } from "../lib/helpers"
import type { Env } from "../types"

const jobs = new Hono<{ Bindings: Env }>()

jobs.get("/:jobId", async (c) => {
  try {
    const token = requireBearerToken(c.req.header("authorization"))
    const repository = getControlPlaneCommunityRepository(c.env)
    const result = await getJob({
      env: c.env,
      bearerToken: token,
      jobId: c.req.param("jobId"),
      repository,
    })
    return c.json(result, 200)
  } catch (error) {
    const response = errorResponse(error)
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    })
  }
})

export default jobs
