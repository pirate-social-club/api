/**
 * Self-contained, MANUAL staging smoke for the community create/provisioning path:
 * upstream-JWT auth -> POST /communities -> poll /jobs/:id and /communities/:id.
 *
 * This creates a real staging community and permanently consumes one staging D1
 * pool binding because staging archive/delete does not currently release loaded
 * bindings. It is intentionally not scheduled; run it on demand after staging
 * deploys or provisioning changes.
 */

import {
  asObject,
  asString,
  createSmokeCommunity,
  fail,
  mintSmokeAccessToken,
  requestJson,
} from "./staging-smoke-support"

const apiBase = (process.env.PIRATE_SMOKE_API_BASE_URL ?? "https://api-staging.pirate.sc").replace(/\/$/, "")
const subject = process.env.PIRATE_SMOKE_SUBJECT ?? "usr_community_create_ci_smoke"
const timeoutMs = Number(process.env.PIRATE_SMOKE_TIMEOUT_MS ?? "120000")
const pollIntervalMs = Number(process.env.PIRATE_SMOKE_POLL_INTERVAL_MS ?? "3000")
const suffix = `${Date.now()}`
const prefix = "community-create-smoke"

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pollProvisioning(input: {
  token: string
  communityId: string
  jobId: string
}): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastJobStatus = ""
  let lastProvisioningState = ""

  while (Date.now() <= deadline) {
    const job = await requestJson({
      method: "GET",
      url: `${apiBase}/jobs/${encodeURIComponent(input.jobId)}`,
      token: input.token,
      okStatuses: [200],
      prefix,
    })
    lastJobStatus = asString(job.status, "job.status", prefix)
    if (lastJobStatus === "failed") {
      fail(prefix, `provisioning job failed: ${JSON.stringify(job).slice(0, 1000)}`)
    }

    const communityResponse = await requestJson({
      method: "GET",
      url: `${apiBase}/communities/${encodeURIComponent(input.communityId)}`,
      token: input.token,
      okStatuses: [200],
      prefix,
    })
    const community = asObject(communityResponse.community ?? communityResponse, "community", prefix)
    lastProvisioningState = asString(community.provisioning_state, "community.provisioning_state", prefix)
    const status = asString(community.status, "community.status", prefix)

    if (lastJobStatus === "succeeded" && lastProvisioningState === "active" && status === "active") {
      console.log("[community-create-smoke] provisioning succeeded", {
        communityId: input.communityId,
        jobId: input.jobId,
      })
      return
    }

    await sleep(pollIntervalMs)
  }

  fail(
    prefix,
    `timed out waiting for provisioning success after ${timeoutMs}ms; last job=${lastJobStatus}, provisioning=${lastProvisioningState}`,
  )
}

console.log("[community-create-smoke] target", {
  apiBase,
  subject,
  timeoutMs,
})

const token = await mintSmokeAccessToken({ apiBase, subject, prefix })
console.log("[community-create-smoke] authenticated")

const created = await createSmokeCommunity({
  apiBase,
  token,
  displayName: `Community Create CI Smoke ${suffix}`,
  description: "Ephemeral staging smoke community for the create/provisioning path.",
  prefix,
})

console.log("[community-create-smoke] community accepted", {
  communityId: created.communityId,
  jobId: created.jobId,
  initialJobStatus: created.job.status,
  initialProvisioningState: created.community.provisioning_state,
})

await pollProvisioning({ token, communityId: created.communityId, jobId: created.jobId })

console.log("[community-create-smoke] ok", {
  communityId: created.communityId,
  jobId: created.jobId,
})
