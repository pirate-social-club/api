import { Hono } from "hono"

import {
  authenticate,
  type AuthenticatedEnv,
} from "../lib/auth-middleware"
import {
  parseDanceReferenceTerminalFacts,
  type DanceReferenceTerminalFacts,
} from "../lib/dance/choreography-reference-contract"
import {
  finalizeDanceChoreographyReference as realFinalizeDanceChoreographyReference,
  getReadyDanceChoreographyByHostPost as realGetReadyDanceChoreographyByHostPost,
  getReadyDanceChoreographyById as realGetReadyDanceChoreographyById,
  seedOperatorDanceChoreography as realSeedOperatorDanceChoreography,
  type OperatorDanceChoreographySeed,
} from "../lib/dance/choreography-reference-repository"
import { verifyDanceGraderCallback } from "../lib/dance/grader-callback-auth"
import { danceReferenceFeatureStorageRef } from "../lib/dance/choreography-reference-storage"
import { assertDanceReferenceMediaObjectKey } from "../lib/dance/choreography-reference-storage"
import { buildDanceReferencePlaybackUrl as realBuildDanceReferencePlaybackUrl } from "../lib/dance/choreography-reference-storage"
import { isDanceChoreographyEnabled } from "../lib/dance/capture-policy"
import { badRequestError, HttpError, notFoundError } from "../lib/errors"
import {
  authenticateOperatorCredential as realAuthenticateOperatorCredential,
  DANCE_CHOREOGRAPHY_SEED_SCOPE,
  requireOperatorScope,
} from "../lib/operator-credential-auth"
import { getControlPlaneClient as realGetControlPlaneClient } from "../lib/runtime-deps"
import {
  decodePublicPostId,
  publicCommunityId,
  publicId,
  publicPostId,
} from "../lib/public-ids"

const SHA256 = /^[0-9a-f]{64}$/
const MIME_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"])
const MIRROR_POLICIES = new Set(["strict", "allowed"])
const MAX_CALLBACK_BODY_BYTES = 64 * 1024

type DanceChoreographyRouteServices = {
  getControlPlaneClient: typeof realGetControlPlaneClient
  authenticateOperatorCredential: typeof realAuthenticateOperatorCredential
  seedOperatorDanceChoreography: typeof realSeedOperatorDanceChoreography
  finalizeDanceChoreographyReference: typeof realFinalizeDanceChoreographyReference
  getReadyDanceChoreographyById?: typeof realGetReadyDanceChoreographyById
  getReadyDanceChoreographyByHostPost?: typeof realGetReadyDanceChoreographyByHostPost
  buildDanceReferencePlaybackUrl?: typeof realBuildDanceReferencePlaybackUrl
  now: () => number
}

const realServices: DanceChoreographyRouteServices = {
  getControlPlaneClient: realGetControlPlaneClient,
  authenticateOperatorCredential: realAuthenticateOperatorCredential,
  seedOperatorDanceChoreography: realSeedOperatorDanceChoreography,
  finalizeDanceChoreographyReference: realFinalizeDanceChoreographyReference,
  getReadyDanceChoreographyById: realGetReadyDanceChoreographyById,
  getReadyDanceChoreographyByHostPost: realGetReadyDanceChoreographyByHostPost,
  buildDanceReferencePlaybackUrl: realBuildDanceReferencePlaybackUrl,
  now: () => Date.now(),
}

let servicesForTests: DanceChoreographyRouteServices | null = null

export function setDanceChoreographyRouteServicesForTests(
  services: DanceChoreographyRouteServices | null,
): void {
  servicesForTests = services
}

function services(): DanceChoreographyRouteServices {
  return servicesForTests ?? realServices
}

function recordBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequestError("Request body is invalid")
  }
  return value as Record<string, unknown>
}

function stringField(
  body: Record<string, unknown>,
  field: string,
  maximum = 500,
): string {
  const value = body[field]
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw badRequestError(`${field} is invalid`)
  }
  return value
}

function integerField(
  body: Record<string, unknown>,
  field: string,
  maximum: number,
): number {
  const value = body[field]
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > maximum) {
    throw badRequestError(`${field} is invalid`)
  }
  return Number(value)
}

function parseSeed(body: Record<string, unknown>, now: string): OperatorDanceChoreographySeed {
  const referenceContentSha256 = stringField(body, "reference_content_sha256", 64)
  if (!SHA256.test(referenceContentSha256)) {
    throw badRequestError("reference_content_sha256 is invalid")
  }
  const referenceMimeType = stringField(body, "reference_mime_type", 32)
  if (!MIME_TYPES.has(referenceMimeType)) {
    throw badRequestError("reference_mime_type is invalid")
  }
  const mirrorPolicy = stringField(body, "mirror_policy", 16)
  if (!MIRROR_POLICIES.has(mirrorPolicy)) {
    throw badRequestError("mirror_policy is invalid")
  }
  if (typeof body.official !== "boolean") {
    throw badRequestError("official is invalid")
  }
  return {
    danceChoreographyId: stringField(body, "dance_choreography_id", 100),
    danceChoreographyRevisionId: stringField(body, "dance_choreography_revision_id", 100),
    communityId: stringField(body, "community_id", 100),
    hostPostId: stringField(body, "host_post_id", 100),
    referencedSongPostId: stringField(body, "referenced_song_post_id", 100),
    songArtifactBundleId: stringField(body, "song_artifact_bundle_id", 100),
    creatorUserId: stringField(body, "creator_user_id", 100),
    official: body.official,
    referenceStorageRef: assertDanceReferenceMediaObjectKey(
      stringField(body, "reference_storage_ref", 500),
    ),
    referenceContentSha256,
    referenceMimeType: referenceMimeType as OperatorDanceChoreographySeed["referenceMimeType"],
    referenceSizeBytes: integerField(body, "reference_size_bytes", 64 * 1024 * 1024),
    mirrorPolicy: mirrorPolicy as OperatorDanceChoreographySeed["mirrorPolicy"],
    now,
  }
}

function parseJsonBytes(body: Uint8Array): Record<string, unknown> {
  try {
    return recordBody(JSON.parse(new TextDecoder().decode(body)))
  } catch (error) {
    if (error instanceof SyntaxError) throw badRequestError("Request body is invalid")
    throw error
  }
}

const danceChoreographies = new Hono<AuthenticatedEnv>()

function assertChoreographyEnabled(env: AuthenticatedEnv["Bindings"]): void {
  if (!isDanceChoreographyEnabled(env)) {
    throw new HttpError(
      503,
      "dance_choreography_disabled",
      "Dance choreography is unavailable",
      false,
    )
  }
}

export async function choreographyResponse(
  env: AuthenticatedEnv["Bindings"],
  record: NonNullable<Awaited<ReturnType<typeof realGetReadyDanceChoreographyById>>>,
  now: number,
) {
  const playbackUrl = await (
    services().buildDanceReferencePlaybackUrl ?? realBuildDanceReferencePlaybackUrl
  )({
    env,
    referenceStorageRef: record.referenceStorageRef,
    now: new Date(now),
  })
  return {
    id: record.danceChoreographyId,
    object: "dance_choreography" as const,
    community: publicCommunityId(record.communityId),
    post: publicPostId(record.hostPostId),
    song_post: publicPostId(record.referencedSongPostId),
    song_artifact_bundle: publicId(record.songArtifactBundleId, "sab"),
    creator: publicId(record.creatorUserId, "usr"),
    official: record.official,
    revision: record.danceChoreographyRevisionId,
    mirror_policy: record.mirrorPolicy,
    reference: {
      url: playbackUrl,
      mime_type: record.referenceMimeType,
      duration_ms: record.referenceDurationMs,
      width: record.referenceWidth,
      height: record.referenceHeight,
    },
  }
}

danceChoreographies.get("/:choreographyId", authenticate, async (c) => {
  assertChoreographyEnabled(c.env)
  const routeServices = services()
  const record = await (
    routeServices.getReadyDanceChoreographyById ?? realGetReadyDanceChoreographyById
  )({
    client: routeServices.getControlPlaneClient(c.env),
    danceChoreographyId: c.req.param("choreographyId"),
  })
  if (!record) throw notFoundError("Dance choreography not found")
  c.header("Cache-Control", "private, no-store")
  return c.json(await choreographyResponse(c.env, record, routeServices.now()))
})

danceChoreographies.post("/operator/seed", async (c) => {
  const routeServices = services()
  const operator = await routeServices.authenticateOperatorCredential({
    env: c.env,
    authorization: c.req.header("authorization"),
  })
  requireOperatorScope(operator, DANCE_CHOREOGRAPHY_SEED_SCOPE)

  const body = recordBody(await c.req.json().catch(() => null))
  const result = await routeServices.seedOperatorDanceChoreography({
    client: routeServices.getControlPlaneClient(c.env),
    seed: parseSeed(body, new Date(routeServices.now()).toISOString()),
  })
  return c.json({
    choreography: result.record.danceChoreographyId,
    revision: result.record.danceChoreographyRevisionId,
    status: result.record.revisionStatus,
    idempotent: result.kind === "idempotent",
  }, result.kind === "created" ? 201 : 200)
})

danceChoreographies.post("/revisions/:revisionId/reference-callback", async (c) => {
  const routeServices = services()
  const revisionId = c.req.param("revisionId")
  const contentLength = Number(c.req.header("content-length"))
  if (Number.isFinite(contentLength) && contentLength > MAX_CALLBACK_BODY_BYTES) {
    throw badRequestError("Request body is too large")
  }
  const bodyBytes = new Uint8Array(await c.req.raw.arrayBuffer())
  if (bodyBytes.byteLength > MAX_CALLBACK_BODY_BYTES) {
    throw badRequestError("Request body is too large")
  }
  const body = parseJsonBytes(bodyBytes)
  const subject = stringField(body, "subject", 100)
  if (subject !== revisionId) throw badRequestError("subject does not match revision")

  verifyDanceGraderCallback({
    env: c.env,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    timestampHeader: c.req.header("x-dance-grader-timestamp"),
    keyVersionHeader: c.req.header("x-dance-grader-key-version"),
    signatureHeader: c.req.header("x-dance-grader-signature"),
    subject,
    body: bodyBytes,
    nowSeconds: Math.floor(routeServices.now() / 1000),
  })

  const facts: DanceReferenceTerminalFacts = parseDanceReferenceTerminalFacts(body)
  const result = await routeServices.finalizeDanceChoreographyReference({
    client: routeServices.getControlPlaneClient(c.env),
    danceChoreographyRevisionId: revisionId,
    facts,
    referenceFeatureRef: facts.outcome === "ready"
      ? danceReferenceFeatureStorageRef(revisionId)
      : undefined,
    now: new Date(routeServices.now()).toISOString(),
    transientRetryAt: facts.outcome === "failed" && facts.reason === "scoring_unavailable"
      ? new Date(routeServices.now() + 60_000).toISOString()
      : undefined,
  })
  return c.json({
    revision: revisionId,
    status: result.kind === "retryable_failure"
      ? "processing"
      : result.record.revisionStatus,
    idempotent: result.kind === "idempotent",
    retryable: result.kind === "retryable_failure",
  }, result.kind === "retryable_failure" ? 202 : 200)
})

export default danceChoreographies

export const postDanceChoreographies = new Hono<AuthenticatedEnv>()
postDanceChoreographies.get("/:postId/dance-choreography", authenticate, async (c) => {
  assertChoreographyEnabled(c.env)
  const routeServices = services()
  const record = await (
    routeServices.getReadyDanceChoreographyByHostPost
      ?? realGetReadyDanceChoreographyByHostPost
  )({
    client: routeServices.getControlPlaneClient(c.env),
    hostPostId: decodePublicPostId(c.req.param("postId")),
  })
  if (!record) throw notFoundError("Dance choreography not found")
  c.header("Cache-Control", "private, no-store")
  return c.json(await choreographyResponse(c.env, record, routeServices.now()))
})
