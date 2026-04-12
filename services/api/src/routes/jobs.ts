import { Hono } from "hono"
import { getRedditOnboardingRepository, getUserRepository } from "../lib/auth/repositories"
import {
  parseCommunityPostProjectionReconcileLimit,
  reconcileRecentCommunityPostProjections,
} from "../lib/communities/community-post-projection-reconcile-service"
import { getJob } from "../lib/communities/community-service"
import { getControlPlaneCommunityRepository } from "../lib/communities/control-plane-community-repository"
import { getControlPlaneSongArtifactBundleRepository } from "../lib/posts/control-plane-song-artifact-repository"
import {
  drainPendingSongArtifactEnrichments,
  parseSongEnrichmentDrainLimit,
} from "../lib/posts/song-enrichment-service"
import {
  drainPendingSongArtifactPreviews,
  parseSongPreviewDrainLimit,
} from "../lib/posts/song-preview-job-service"
import {
  drainPendingSongAssetStoryPublishes,
  parseSongAssetStoryDrainLimit,
} from "../lib/posts/song-asset-story-service"
import {
  drainPendingSongAssetLockedDeliveries,
  parseSongLockedDeliveryDrainLimit,
} from "../lib/posts/song-asset-locked-delivery-service"
import { authError } from "../lib/errors"
import { requireBearerToken } from "../lib/helpers"
import { handleRoute } from "./route-helpers"
import type { Env } from "../types"

const jobs = new Hono<{ Bindings: Env }>()

function routeParam(c: { req: { param(name: string): string | undefined } }, name: string): string {
  return c.req.param(name) ?? ""
}

function requireInternalJobRunnerToken(c: { req: { header(name: string): string | undefined }; env: Env }): void {
  const expected = String(c.env.INTERNAL_JOB_RUNNER_TOKEN || "").trim()
  const actual = requireBearerToken(c.req.header("authorization"))
  if (!expected || actual !== expected) {
    throw authError("Authentication failed")
  }
}

function parsePositiveInt(value: string | null | undefined, fallback: number): number {
  const parsed = Number(String(value ?? "").trim())
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.trunc(parsed)
}

jobs.post("/internal/reddit-imports/drain", handleRoute(async (c) => {
  requireInternalJobRunnerToken(c)
  const repository = getRedditOnboardingRepository(c.env)
  const staleAfterSeconds = parsePositiveInt(
    c.req.query("stale_after_seconds"),
    parsePositiveInt(c.env.REDDIT_IMPORT_JOB_STALE_AFTER_SECONDS, 300),
  )
  const maxJobs = parsePositiveInt(
    c.req.query("limit"),
    parsePositiveInt(c.env.REDDIT_IMPORT_JOB_DRAIN_LIMIT, 10),
  )
  const result = await repository.drainRedditSnapshotImportJobs({
    env: c.env,
    maxJobs,
    staleAfterSeconds,
  })
  return c.json({
    recovered_count: result.recoveredCount,
    drained_count: result.drainedCount,
  }, 200)
}))

jobs.post("/internal/song-enrichments/drain", handleRoute(async (c) => {
  requireInternalJobRunnerToken(c)
  const result = await drainPendingSongArtifactEnrichments({
    env: c.env,
    limit: parseSongEnrichmentDrainLimit(c.req.query("limit"), c.env),
    songArtifactRepository: getControlPlaneSongArtifactBundleRepository(c.env),
    communityRepository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

jobs.post("/internal/song-previews/drain", handleRoute(async (c) => {
  requireInternalJobRunnerToken(c)
  const result = await drainPendingSongArtifactPreviews({
    env: c.env,
    limit: parseSongPreviewDrainLimit(c.req.query("limit"), c.env),
    songArtifactRepository: getControlPlaneSongArtifactBundleRepository(c.env),
  })
  return c.json(result, 200)
}))

jobs.post("/internal/song-assets/drain", handleRoute(async (c) => {
  requireInternalJobRunnerToken(c)
  const result = await drainPendingSongAssetStoryPublishes({
    env: c.env,
    limit: parseSongAssetStoryDrainLimit(c.req.query("limit"), c.env),
    communityRepository: getControlPlaneCommunityRepository(c.env),
    userRepository: getUserRepository(c.env),
  })
  return c.json(result, 200)
}))

jobs.post("/internal/song-locked-deliveries/drain", handleRoute(async (c) => {
  requireInternalJobRunnerToken(c)
  const result = await drainPendingSongAssetLockedDeliveries({
    env: c.env,
    limit: parseSongLockedDeliveryDrainLimit(c.req.query("limit"), c.env),
    communityRepository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

jobs.post("/internal/community-post-projections/reconcile", handleRoute(async (c) => {
  requireInternalJobRunnerToken(c)
  const result = await reconcileRecentCommunityPostProjections({
    env: c.env,
    limit: parseCommunityPostProjectionReconcileLimit(c.req.query("limit"), c.env),
    communityRepository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

jobs.get("/:jobId", handleRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const repository = getControlPlaneCommunityRepository(c.env)
  const result = await getJob({
    env: c.env,
    bearerToken: token,
    jobId: routeParam(c, "jobId"),
    repository,
  })
  return c.json(result, 200)
}))

export default jobs
