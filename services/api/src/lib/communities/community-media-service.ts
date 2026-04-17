import { assertMediaObject, fetchMedia, uploadMedia } from "../media-storage"
import type { Env } from "../../types"

export type CommunityMediaKind = "avatar" | "banner"
const maxBytesByKind: Record<CommunityMediaKind, number> = {
  avatar: 5 * 1024 * 1024,
  banner: 12 * 1024 * 1024,
}

export async function uploadCommunityMedia(input: {
  env: Env
  file: File
  kind: CommunityMediaKind
  origin: string
}): Promise<{
  kind: CommunityMediaKind
  media_ref: string
  mime_type: string
  size_bytes: number
  storage_bucket: string
  storage_object_key: string
}> {
  return await uploadMedia({
    env: input.env,
    file: input.file,
    kind: input.kind,
    origin: input.origin,
    routePrefix: "community-media",
    objectKeyPrefix: "community-media",
    maxBytesByKind,
  })
}

export function assertCommunityMediaObject(input: {
  kind: string
  objectName: string
}): { kind: CommunityMediaKind; objectKey: string } {
  return assertMediaObject({
    kind: input.kind,
    objectName: input.objectName,
    allowedKinds: ["avatar", "banner"],
    objectKeyPrefix: "community-media",
    notFoundMessage: "Community media not found",
  })
}

export async function fetchCommunityMedia(input: {
  env: Env
  objectKey: string
}): Promise<Response> {
  return await fetchMedia({
    env: input.env,
    objectKey: input.objectKey,
    notFoundMessage: "Community media not found",
  })
}
