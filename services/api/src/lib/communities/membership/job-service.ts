import { notFoundError } from "../../errors"
import { serializeJob } from "../community-serialization"
import { requireOwnedCommunity } from "../create/service"
import type { Env, Job } from "../../../types"
import type { CommunityMembershipRepository } from "./types"

export async function getJob(input: {
  env: Env
  userId: string
  jobId: string
  repository: CommunityMembershipRepository
}): Promise<Job> {
  const job = await input.repository.getJobById(input.jobId)
  if (!job) {
    throw notFoundError("Job not found")
  }
  if (!job.community_id) {
    throw notFoundError("Job not found")
  }
  await requireOwnedCommunity(input.repository, job.community_id, input.userId)
  return serializeJob(job)
}
