import { apiRoutes, type Job } from "@pirate/api-contracts"
import { apiRequest } from "../http.js"
import { apiAuthHeadersForSession, requireStoredSession } from "../session.js"

type StoredSession = ReturnType<typeof requireStoredSession>

export async function waitForCommunityJob(session: StoredSession, jobId: string): Promise<Job> {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const job = await apiRequest<Job>({
      baseUrl: session.baseUrl,
      path: apiRoutes.job(jobId),
      ...apiAuthHeadersForSession(session),
    })
    if (job.status === "succeeded") {
      return job
    }
    if (job.status === "failed") {
      throw new Error(`Community provisioning failed: ${job.error_code ?? "unknown_error"}`)
    }
    await delay(5000)
  }

  throw new Error(`Timed out waiting for community provisioning job ${jobId}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}
