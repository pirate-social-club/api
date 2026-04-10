import { apiRoutes, type Job } from "@pirate/api-contracts"
import { apiRequest } from "../http.js"
import { exitWithUsage, printJson } from "../output.js"
import { requireStoredSession } from "../session.js"

export async function runJob(action: string | undefined, rest: string[]): Promise<void> {
  const session = requireStoredSession()
  if (action !== "get") {
    exitWithUsage("Usage: pirate job get <job_id>")
  }
  const jobId = rest[0]
  if (!jobId) {
    exitWithUsage("Usage: pirate job get <job_id>")
  }
  const result = await apiRequest<Job>({
    baseUrl: session.baseUrl,
    path: apiRoutes.job(jobId),
    accessToken: session.accessToken,
  })
  printJson(result)
}
