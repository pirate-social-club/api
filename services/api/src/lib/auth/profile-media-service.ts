import { assertMediaObject, fetchMedia, uploadMedia } from "../media-storage"
import type { Env } from "../../env"

export type ProfileMediaKind = "avatar" | "cover"
const maxBytesByKind: Record<ProfileMediaKind, number> = {
  avatar: 5 * 1024 * 1024,
  cover: 12 * 1024 * 1024,
}

export async function uploadProfileMedia(input: {
  env: Env
  file: File
  kind: ProfileMediaKind
  origin: string
}): Promise<{
  kind: ProfileMediaKind
  media_ref: string
  ipfs_cid: string
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
    routePrefix: "profile-media",
    objectKeyPrefix: "profile-media",
    maxBytesByKind,
  })
}

export function assertProfileMediaObject(input: {
  kind: string
  objectName: string
}): { kind: ProfileMediaKind; objectKey: string } {
  return assertMediaObject({
    kind: input.kind,
    objectName: input.objectName,
    allowedKinds: ["avatar", "cover"],
    objectKeyPrefix: "profile-media",
    notFoundMessage: "Profile media not found",
  })
}

export async function fetchProfileMedia(input: {
  env: Env
  objectKey: string
}): Promise<Response> {
  return await fetchMedia({
    env: input.env,
    objectKey: input.objectKey,
    notFoundMessage: "Profile media not found",
  })
}
