import { badRequestError } from "../errors"
import { resolveFilebaseConfig } from "../storage/filebase-config"
import { buildS3PresignedUrl } from "../storage/s3-signing"
import type { Env } from "../../env"

const MAX_OBJECT_KEY_LENGTH = 1024

export function assertDanceStorageObjectKey(value: string): string {
  const normalized = value.trim()
  if (
    !normalized
    || normalized.length > MAX_OBJECT_KEY_LENGTH
    || normalized.startsWith("/")
    || normalized.includes("://")
    || normalized.split("/").some((segment) => segment === ".." || segment === "")
  ) {
    throw badRequestError("Dance reference storage object key is invalid")
  }
  return normalized
}

export function danceReferenceFeatureStorageRef(revisionId: string): string {
  return assertDanceStorageObjectKey(
    `dance/reference-features/${revisionId}.json`,
  )
}

export async function buildDanceReferenceSignedUrls(input: {
  env: Env
  referenceStorageRef: string
  danceChoreographyRevisionId: string
  now: Date
  expiresInSeconds?: number
}): Promise<{ mediaGetUrl: string; artifactPutUrl: string; artifactStorageRef: string }> {
  const config = resolveFilebaseConfig(input.env)
  const artifactStorageRef = danceReferenceFeatureStorageRef(
    input.danceChoreographyRevisionId,
  )
  const common = {
    config,
    expiresInSeconds: input.expiresInSeconds ?? 300,
    now: input.now,
    bodyHashMode: "unsigned" as const,
  }
  const [mediaGetUrl, artifactPutUrl] = await Promise.all([
    buildS3PresignedUrl({
      ...common,
      method: "GET",
      objectKey: assertDanceStorageObjectKey(input.referenceStorageRef),
    }),
    buildS3PresignedUrl({
      ...common,
      method: "PUT",
      objectKey: artifactStorageRef,
      headers: { "content-type": "application/json" },
    }),
  ])
  return {
    mediaGetUrl: mediaGetUrl.toString(),
    artifactPutUrl: artifactPutUrl.toString(),
    artifactStorageRef,
  }
}

export async function buildDanceReferencePlaybackUrl(input: {
  env: Env
  referenceStorageRef: string
  now: Date
  expiresInSeconds?: number
}): Promise<string> {
  const url = await buildS3PresignedUrl({
    config: resolveFilebaseConfig(input.env),
    method: "GET",
    objectKey: assertDanceStorageObjectKey(input.referenceStorageRef),
    expiresInSeconds: input.expiresInSeconds ?? 300,
    now: input.now,
    bodyHashMode: "unsigned",
  })
  return url.toString()
}
