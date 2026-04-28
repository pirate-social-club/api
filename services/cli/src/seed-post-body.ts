import { getFlag } from "./args.js"
import { readJsonFile, readOptionalTextFile, stringField } from "./command-utils.js"
import type { ParsedArgs } from "./types.js"

type SeedPostType = "text" | "link" | "image" | "video" | "song"
type TextReader = (field: string) => string | null

export function buildSeedPostBodyFromArgs(args: ParsedArgs): Record<string, unknown> {
  return buildSeedPostBody({
    idempotencyKey: getFlag(args, "idempotency-key"),
    postType: getFlag(args, "post-type"),
    title: getFlag(args, "title") ?? readOptionalTextFile(getFlag(args, "title-file")),
    body: getFlag(args, "body") ?? readOptionalTextFile(getFlag(args, "body-file")),
    caption: getFlag(args, "caption") ?? readOptionalTextFile(getFlag(args, "caption-file")),
    visibility: getFlag(args, "visibility"),
    identityMode: getFlag(args, "identity-mode"),
    linkUrl: getFlag(args, "link-url"),
    mediaRefs: getFlag(args, "media-refs-file") ? readMediaRefsFile(getFlag(args, "media-refs-file")!) : null,
    mediaRef: getFlag(args, "media-ref"),
    mimeType: getFlag(args, "mime-type"),
    sizeBytes: parseOptionalInteger(getFlag(args, "size-bytes"), "size-bytes"),
    width: parseOptionalInteger(getFlag(args, "width"), "width"),
    height: parseOptionalInteger(getFlag(args, "height"), "height"),
    durationMs: parseOptionalInteger(getFlag(args, "duration-ms"), "duration-ms"),
    contentHash: getFlag(args, "content-hash"),
    posterRef: getFlag(args, "poster-ref"),
    posterMimeType: getFlag(args, "poster-mime-type"),
    posterWidth: parseOptionalInteger(getFlag(args, "poster-width"), "poster-width"),
    posterHeight: parseOptionalInteger(getFlag(args, "poster-height"), "poster-height"),
    posterFrameMs: parseOptionalInteger(getFlag(args, "poster-frame-ms"), "poster-frame-ms"),
    accessMode: getFlag(args, "access-mode"),
    licensePreset: getFlag(args, "license-preset"),
    commercialRevSharePct: parseOptionalNumber(getFlag(args, "commercial-rev-share-pct"), "commercial-rev-share-pct"),
    songArtifactBundleId: getFlag(args, "song-artifact-bundle-id"),
    songMode: getFlag(args, "song-mode"),
    rightsBasis: getFlag(args, "rights-basis"),
    upstreamAssetRefs: getFlag(args, "upstream-asset-refs-file")
      ? readStringArrayFile(getFlag(args, "upstream-asset-refs-file")!, "--upstream-asset-refs-file")
      : null,
  })
}

export function buildSeedPostBodyFromManifest(
  item: Record<string, unknown>,
  readTextField: TextReader,
): Record<string, unknown> {
  return buildSeedPostBody({
    idempotencyKey: stringField(item, "idempotency_key"),
    postType: stringField(item, "post_type"),
    title: stringField(item, "title") ?? readTextField("title_file"),
    body: stringField(item, "body") ?? readTextField("body_file"),
    caption: stringField(item, "caption") ?? readTextField("caption_file"),
    visibility: stringField(item, "visibility"),
    identityMode: stringField(item, "identity_mode"),
    linkUrl: stringField(item, "link_url"),
    mediaRefs: manifestMediaRefs(item, readTextField),
    mediaRef: stringField(item, "media_ref"),
    mimeType: stringField(item, "mime_type"),
    sizeBytes: manifestOptionalInteger(item, "size_bytes"),
    width: manifestOptionalInteger(item, "width"),
    height: manifestOptionalInteger(item, "height"),
    durationMs: manifestOptionalInteger(item, "duration_ms"),
    contentHash: stringField(item, "content_hash"),
    posterRef: stringField(item, "poster_ref"),
    posterMimeType: stringField(item, "poster_mime_type"),
    posterWidth: manifestOptionalInteger(item, "poster_width"),
    posterHeight: manifestOptionalInteger(item, "poster_height"),
    posterFrameMs: manifestOptionalInteger(item, "poster_frame_ms"),
    accessMode: stringField(item, "access_mode"),
    licensePreset: stringField(item, "license_preset"),
    commercialRevSharePct: manifestOptionalNumber(item, "commercial_rev_share_pct"),
    songArtifactBundleId: stringField(item, "song_artifact_bundle_id"),
    songMode: stringField(item, "song_mode"),
    rightsBasis: stringField(item, "rights_basis"),
    upstreamAssetRefs: manifestStringArray(item, "upstream_asset_refs", "upstream_asset_refs_file", readTextField),
  })
}

function buildSeedPostBody(input: {
  idempotencyKey: string | null
  postType: string | null
  title: string | null
  body: string | null
  caption: string | null
  visibility: string | null
  identityMode: string | null
  linkUrl: string | null
  mediaRefs: unknown[] | null
  mediaRef: string | null
  mimeType: string | null
  sizeBytes: number | null
  width: number | null
  height: number | null
  durationMs: number | null
  contentHash: string | null
  posterRef: string | null
  posterMimeType: string | null
  posterWidth: number | null
  posterHeight: number | null
  posterFrameMs: number | null
  accessMode: string | null
  licensePreset: string | null
  commercialRevSharePct: number | null
  songArtifactBundleId: string | null
  songMode: string | null
  rightsBasis: string | null
  upstreamAssetRefs: string[] | null
}): Record<string, unknown> {
  if (!input.idempotencyKey) {
    throw new Error("Seed post requires idempotency_key or --idempotency-key")
  }

  const postType = parseSeedPostType(input.postType)
  const body: Record<string, unknown> = {
    post_type: postType,
    identity_mode: input.identityMode ?? "public",
    visibility: input.visibility ?? "public",
    idempotency_key: input.idempotencyKey,
  }

  if (input.title?.trim()) body.title = input.title.trim()
  if (input.caption?.trim()) body.caption = input.caption

  if (postType === "text") {
    if (!input.body?.trim()) {
      throw new Error("Text seed posts require body/body_file or --body/--body-file")
    }
    body.body = input.body
    return body
  }

  if (input.body?.trim()) body.body = input.body

  if (postType === "link") {
    if (!input.linkUrl?.trim()) {
      throw new Error("Link seed posts require link_url or --link-url")
    }
    body.link_url = input.linkUrl.trim()
    return body
  }

  if (postType === "image" || postType === "video") {
    const mediaRefs = input.mediaRefs ?? buildSingleMediaRef(input)
    if (!mediaRefs.length) {
      throw new Error(`${capitalize(postType)} seed posts require media_refs/media_refs_file or --media-ref with --mime-type`)
    }
    body.media_refs = mediaRefs
    addAssetFields(body, input)
    return body
  }

  if (!input.songArtifactBundleId?.trim()) {
    throw new Error("Song seed posts require song_artifact_bundle_id or --song-artifact-bundle-id")
  }
  body.song_artifact_bundle_id = input.songArtifactBundleId.trim()
  addAssetFields(body, input)
  if (input.songMode) body.song_mode = input.songMode
  if (input.upstreamAssetRefs) body.upstream_asset_refs = input.upstreamAssetRefs
  return body
}

function addAssetFields(body: Record<string, unknown>, input: {
  accessMode: string | null
  licensePreset: string | null
  commercialRevSharePct: number | null
  rightsBasis: string | null
}): void {
  if (input.accessMode) body.access_mode = input.accessMode
  if (input.licensePreset) body.license_preset = input.licensePreset
  if (input.commercialRevSharePct != null) body.commercial_rev_share_pct = input.commercialRevSharePct
  if (input.rightsBasis) body.rights_basis = input.rightsBasis
}

function parseSeedPostType(value: string | null): SeedPostType {
  const postType = value ?? "text"
  if (postType === "text" || postType === "link" || postType === "image" || postType === "video" || postType === "song") {
    return postType
  }
  throw new Error("Seed post post_type must be text, link, image, video, or song")
}

function buildSingleMediaRef(input: {
  mediaRef: string | null
  mimeType: string | null
  sizeBytes: number | null
  width: number | null
  height: number | null
  durationMs: number | null
  contentHash: string | null
  posterRef: string | null
  posterMimeType: string | null
  posterWidth: number | null
  posterHeight: number | null
  posterFrameMs: number | null
}): unknown[] {
  if (!input.mediaRef && !input.mimeType) {
    return []
  }
  if (!input.mediaRef || !input.mimeType) {
    throw new Error("Media seed posts require both media_ref and mime_type")
  }
  return [dropNullish({
    storage_ref: input.mediaRef,
    mime_type: input.mimeType,
    size_bytes: input.sizeBytes,
    width: input.width,
    height: input.height,
    duration_ms: input.durationMs,
    content_hash: input.contentHash,
    poster_ref: input.posterRef,
    poster_mime_type: input.posterMimeType,
    poster_width: input.posterWidth,
    poster_height: input.posterHeight,
    poster_frame_ms: input.posterFrameMs,
  })]
}

function manifestMediaRefs(item: Record<string, unknown>, readTextField: TextReader): unknown[] | null {
  if (Array.isArray(item.media_refs)) {
    return item.media_refs
  }
  if (!stringField(item, "media_refs_file")) {
    return null
  }
  const raw = readTextField("media_refs_file")
  const parsed = raw ? JSON.parse(raw) as unknown : null
  if (!Array.isArray(parsed)) {
    throw new Error("media_refs_file must contain a JSON array")
  }
  return parsed
}

function readMediaRefsFile(filePath: string): unknown[] {
  const parsed = readJsonFile(filePath)
  if (!Array.isArray(parsed)) {
    throw new Error("--media-refs-file must contain a JSON array")
  }
  return parsed
}

function manifestStringArray(
  item: Record<string, unknown>,
  field: string,
  fileField: string,
  readTextField: TextReader,
): string[] | null {
  const value = item[field]
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value
  }
  if (!stringField(item, fileField)) {
    return null
  }
  const raw = readTextField(fileField)
  const parsed = raw ? JSON.parse(raw) as unknown : null
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error(`${fileField} must contain a JSON string array`)
  }
  return parsed
}

function readStringArrayFile(filePath: string, label: string): string[] {
  const parsed = readJsonFile(filePath)
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error(`${label} must contain a JSON string array`)
  }
  return parsed
}

function manifestOptionalInteger(item: Record<string, unknown>, field: string): number | null {
  const value = item[field]
  if (value == null || value === "") {
    return null
  }
  return parseOptionalInteger(String(value), field)
}

function parseOptionalInteger(value: string | null, field: string): number | null {
  if (value == null || value === "") {
    return null
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative integer`)
  }
  return parsed
}

function manifestOptionalNumber(item: Record<string, unknown>, field: string): number | null {
  const value = item[field]
  if (value == null || value === "") {
    return null
  }
  return parseOptionalNumber(String(value), field)
}

function parseOptionalNumber(value: string | null, field: string): number | null {
  if (value == null || value === "") {
    return null
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be a number`)
  }
  return parsed
}

function dropNullish(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value != null && value !== ""))
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`
}
