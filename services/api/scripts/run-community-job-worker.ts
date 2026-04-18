import { getCommunityRepository } from "../src/lib/communities/db-community-repository"
import { processAvailableCommunityJobs } from "../src/lib/communities/community-job-runner"
import type { Env } from "../src/types"
import { readDevVarsFromCwd } from "./_lib/dev-vars"
import {
  applyLocalControlPlaneMigrations,
  ensureLocalDevStorage,
  resolveLocalDevStorage,
} from "./_lib/local-dev-storage"
import { readdir } from "node:fs/promises"

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

  const communityRepository = getCommunityRepository(env)

  while (!abortController.signal.aborted) {
    const localCommunityIds = await discoverLocalCommunityIds(localDevStorage.communityDbRoot)
    let activeCommunityIds: string[] = []
    try {
      activeCommunityIds = (await communityRepository.listActiveCommunities()).map((community) => community.community_id)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`community job worker: failed to list active communities (${message}); falling back to local db scan`)
    }

    const communityIds = [...new Set([...activeCommunityIds, ...localCommunityIds])]
      .slice(0, maxCommunitiesPerTick)

    const summary = await processAvailableCommunityJobs({
      env,
      communityRepository,
      communityIds,
      maxCommunities: maxCommunitiesPerTick,
      maxJobsPerCommunity,
    })

    if (summary.processed_jobs === 0) {
      console.log("community job worker tick: idle")
      if (stopWhenIdle) {
        return
      }
    } else {
      console.log(
        `community job worker tick: processed ${summary.processed_jobs} jobs across ${summary.communities.length} communities`,
      )
      for (const community of summary.communities) {
        console.log(
          `  ${community.community_id}: ${community.processed_jobs} (${community.jobs.map((job) => job.job_type).join(", ")})`,
        )
      }
    }

    if (abortController.signal.aborted) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
}

async function discoverLocalCommunityIds(rootDir: string): Promise<string[]> {
  const entries = await readdir(rootDir, { withFileTypes: true }).catch(() => [])
  const communityIds = new Set<string>()

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue
    }

    const communityDbMatch = /^community-(cmt_[^.]+)\.db$/u.exec(entry.name)
    if (communityDbMatch?.[1]) {
      communityIds.add(communityDbMatch[1])
      continue
    }

    const sqliteMatch = /^(cmt_[^.]+)\.sqlite$/u.exec(entry.name)
    if (sqliteMatch?.[1]) {
      communityIds.add(sqliteMatch[1])
    }
  }

  return [...communityIds]
}

await main()
