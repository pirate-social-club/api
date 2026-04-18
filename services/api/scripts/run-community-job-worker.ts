import { getCommunityRepository } from "../src/lib/communities/db-community-repository"
import { runCommunityJobWorkerLoop } from "../src/lib/communities/community-job-runner"
import type { Env } from "../src/types"
import { readDevVarsFromCwd } from "./_lib/dev-vars"
import {
  applyLocalControlPlaneMigrations,
  ensureLocalDevStorage,
  resolveLocalDevStorage,
} from "./_lib/local-dev-storage"

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? "")
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.trunc(parsed)
}

async function main(): Promise<void> {
  const baseEnv = {
    ...readDevVarsFromCwd(),
    ...process.env,
  }
  const localDevStorage = resolveLocalDevStorage(baseEnv)
  await ensureLocalDevStorage(localDevStorage)

  if (localDevStorage.controlPlaneDbPath) {
    await applyLocalControlPlaneMigrations(localDevStorage)
  }

  const env = {
    ...baseEnv,
    CONTROL_PLANE_DATABASE_URL: localDevStorage.controlPlaneDbUrl,
    LOCAL_COMMUNITY_DB_ROOT: localDevStorage.communityDbRoot,
  } as Env

  const pollIntervalMs = parsePositiveInt(env.COMMUNITY_JOB_WORKER_INTERVAL_MS, 2000)
  const maxJobsPerCommunity = parsePositiveInt(env.COMMUNITY_JOB_WORKER_MAX_JOBS_PER_COMMUNITY, 25)
  const maxCommunitiesPerTick = parsePositiveInt(env.COMMUNITY_JOB_WORKER_MAX_COMMUNITIES_PER_TICK, 100)
  const stopWhenIdle = String(process.env.STOP_WHEN_IDLE || "").trim() === "1"
  const abortController = new AbortController()

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => abortController.abort())
  }

  console.log(
    [
      "community job worker starting",
      `control-plane db: ${localDevStorage.controlPlaneDbPath ?? localDevStorage.controlPlaneDbUrl}`,
      `community db root: ${localDevStorage.communityDbRoot}`,
      `poll interval ms: ${pollIntervalMs}`,
      `max jobs/community: ${maxJobsPerCommunity}`,
      `max communities/tick: ${maxCommunitiesPerTick}`,
      `stop when idle: ${stopWhenIdle ? "yes" : "no"}`,
    ].join("\n"),
  )

  await runCommunityJobWorkerLoop({
    env,
    communityRepository: getCommunityRepository(env),
    pollIntervalMs,
    maxJobsPerCommunity,
    maxCommunities: maxCommunitiesPerTick,
    stopWhenIdle,
    signal: abortController.signal,
    onTick(summary) {
      if (summary.processed_jobs === 0) {
        console.log("community job worker tick: idle")
        return
      }

      console.log(
        `community job worker tick: processed ${summary.processed_jobs} jobs across ${summary.communities.length} communities`,
      )
      for (const community of summary.communities) {
        console.log(
          `  ${community.community_id}: ${community.processed_jobs} (${community.jobs.map((job) => job.job_type).join(", ")})`,
        )
      }
    },
  })
}

await main()
