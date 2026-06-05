import { getCommunityRepository } from "../src/lib/communities/db-community-repository"
import { processAvailableCommunityJobs } from "../src/lib/communities/jobs/runner"
import type { CommunityJobType } from "../src/lib/communities/jobs/store"
import type { Env } from "../src/types"
import { readDevVarsFromCwd, readWranglerVarsFromCwd } from "./_lib/dev-vars"
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

function hasConfiguredValue(value: string | undefined): boolean {
  return String(value ?? "").trim().length > 0
}

function redactedConnectionLabel(value: string): string {
  if (!value.includes("://")) {
    return value
  }
  try {
    const url = new URL(value)
    if (url.username) url.username = "redacted"
    if (url.password) url.password = "redacted"
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|secret|password|auth/i.test(key)) {
        url.searchParams.set(key, "redacted")
      }
    }
    return url.toString()
  } catch {
    return "[remote-control-plane-url]"
  }
}

function envFlag(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null || value.trim() === "") return defaultValue
  const normalized = value.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on"
}

function normalizeWranglerEnvironment(value: string | undefined): string | null {
  const normalized = String(value ?? "").trim().toLowerCase()
  if (!normalized) return null
  if (normalized === "dev" || normalized === "local") return "development"
  if (normalized === "prod") return "production"
  return normalized
}

async function main(): Promise<void> {
  const devVars = readDevVarsFromCwd()
  const wranglerEnvironment = normalizeWranglerEnvironment(
    process.env.PIRATE_COMMUNITY_JOB_WORKER_WRANGLER_ENV
      ?? process.env.WRANGLER_ENV
      ?? process.env.ENVIRONMENT,
  )
  const wranglerVars = wranglerEnvironment
    ? readWranglerVarsFromCwd("wrangler.jsonc", wranglerEnvironment)
    : {}
  const rawEnv = {
    ...devVars,
    ...wranglerVars,
    ...process.env,
    ...(envFlag(process.env.PIRATE_DEV_USE_REMOTE_CONTROL_PLANE, false)
      ? {}
      : {
          CONTROL_PLANE_DATABASE_URL: devVars.CONTROL_PLANE_DATABASE_URL,
          LOCAL_COMMUNITY_DB_ROOT: devVars.LOCAL_COMMUNITY_DB_ROOT,
        }),
  }
  const localDevStorage = resolveLocalDevStorage(rawEnv)
  if (localDevStorage.controlPlaneDbRehomedFromPath) {
    console.warn(
      [
        "community job worker warning: CONTROL_PLANE_DATABASE_URL pointed to a missing local file;",
        `using ${localDevStorage.controlPlaneDbPath} instead of ${localDevStorage.controlPlaneDbRehomedFromPath}.`,
      ].join(" "),
    )
  }
  await ensureLocalDevStorage(localDevStorage)

  if (localDevStorage.controlPlaneDbPath) {
    await applyLocalControlPlaneMigrations(localDevStorage)
  }

  const env = {
    ...rawEnv,
    CONTROL_PLANE_DATABASE_URL: localDevStorage.controlPlaneDbUrl,
    LOCAL_COMMUNITY_DB_ROOT: localDevStorage.communityDbRoot,
  } as Env

  const pollIntervalMs = parsePositiveInt(env.COMMUNITY_JOB_WORKER_INTERVAL_MS, 2000)
  const maxJobsPerCommunity = parsePositiveInt(env.COMMUNITY_JOB_WORKER_MAX_JOBS_PER_COMMUNITY, 25)
  const maxCommunitiesPerTick = parsePositiveInt(env.COMMUNITY_JOB_WORKER_MAX_COMMUNITIES_PER_TICK, 100)
  const explicitCommunityIds = String(process.env.COMMUNITY_JOB_WORKER_COMMUNITY_IDS || "")
    .split(",")
    .map((value) => value.trim().replace(/^com_/, ""))
    .filter(Boolean)
  const skipJobTypes = String(process.env.COMMUNITY_JOB_WORKER_SKIP_JOB_TYPES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean) as CommunityJobType[]
  const stopWhenIdle = String(process.env.STOP_WHEN_IDLE || "").trim() === "1"
  const openRouterConfigured = hasConfiguredValue(env.OPENROUTER_API_KEY)
  const abortController = new AbortController()

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => abortController.abort())
  }

  console.log(
    [
      "community job worker starting",
      `control-plane db: ${localDevStorage.controlPlaneDbPath ?? redactedConnectionLabel(localDevStorage.controlPlaneDbUrl)}`,
      `community db root: ${localDevStorage.communityDbRoot}`,
      `wrangler env: ${wranglerEnvironment ?? "none"}`,
      `poll interval ms: ${pollIntervalMs}`,
      `max jobs/community: ${maxJobsPerCommunity}`,
      `max communities/tick: ${maxCommunitiesPerTick}`,
      `community filter: ${explicitCommunityIds.length ? explicitCommunityIds.join(",") : "all active"}`,
      `skip job types: ${skipJobTypes.length ? skipJobTypes.join(",") : "none"}`,
      `stop when idle: ${stopWhenIdle ? "yes" : "no"}`,
      `openrouter configured: ${openRouterConfigured ? "yes" : "no"}`,
    ].join("\n"),
  )

  if (!openRouterConfigured) {
    console.warn(
      "community job worker warning: OPENROUTER_API_KEY is missing; translation jobs will fail until the worker is started with runtime secrets",
    )
  }

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

    const communityIds = (explicitCommunityIds.length ? explicitCommunityIds : [...new Set([...activeCommunityIds, ...localCommunityIds])])
      .slice(0, maxCommunitiesPerTick)

    let summary: Awaited<ReturnType<typeof processAvailableCommunityJobs>>
    try {
      summary = await processAvailableCommunityJobs({
        env,
        communityRepository,
        communityIds,
        maxCommunities: maxCommunitiesPerTick,
        maxJobsPerCommunity,
        skipJobTypes,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`community job worker: failed to process jobs (${message}); retrying after ${pollIntervalMs}ms`)
      if (abortController.signal.aborted) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
      continue
    }

    if (summary.processed_jobs === 0) {
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
