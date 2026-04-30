export function decodePublicId(value: string, publicPrefix: string): string {
  const trimmed = value.trim()
  const prefix = `${publicPrefix}_`
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed
}

export function publicCommunityId(rawCommunityId: string): string {
  return `com_${rawCommunityId}`
}

export function publicPostId(rawPostId: string): string {
  return `post_${rawPostId}`
}

export function publicCommentId(rawCommentId: string): string {
  return `cmt_${rawCommentId}`
}

export function publicId(rawId: string, publicPrefix: string): string {
  return `${publicPrefix}_${rawId}`
}

export function decodePublicCommunityId(value: string): string {
  return decodePublicId(value, "com")
}

export function decodePublicPostId(value: string): string {
  return decodePublicId(value, "post")
}

export function decodePublicCommentId(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.startsWith("cmt_")) return trimmed
  const stripped = trimmed.slice(4)
  // Raw comment IDs from makeId("cmt") are cmt_<uuid>. Old-format public IDs
  // were returned unchanged (cmt_<uuid>), so stripping one prefix would leave
  // just the UUID. New-format IDs are cmt_cmt_<uuid>. If the stripped result
  // still contains an underscore, we stripped the public prefix; otherwise we
  // stripped the raw prefix from an old-format ID and should return original.
  return stripped.includes("_") ? stripped : trimmed
}

export function decodePublicAgentId(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.startsWith("agt_")) return trimmed
  const stripped = trimmed.slice(4)
  return stripped.includes("_") ? stripped : trimmed
}

export function decodePublicAgentOwnershipSessionId(value: string): string {
  return decodePublicId(value, "aos")
}

export function decodePublicAssetId(value: string): string {
  return decodePublicId(value, "asset")
}

export function decodePublicJobId(value: string): string {
  return decodePublicId(value, "job")
}

export function decodePublicListingId(value: string): string {
  return decodePublicId(value, "lst")
}

export function decodePublicMembershipRequestId(value: string): string {
  return decodePublicId(value, "mrq")
}

export function decodePublicModerationCaseId(value: string): string {
  return decodePublicId(value, "mcase")
}

export function decodePublicNamespaceVerificationId(value: string): string {
  let decoded = value.trim()
  while (decoded.startsWith("nv_nv_")) {
    decoded = decoded.slice("nv_".length)
  }
  return decoded
}

export function decodePublicNamespaceVerificationSessionId(value: string): string {
  let decoded = value.trim()
  while (decoded.startsWith("nvs_nvs_")) {
    decoded = decoded.slice("nvs_".length)
  }
  return decoded
}

export function decodePublicPurchaseId(value: string): string {
  return decodePublicId(value, "pur")
}

export function decodePublicSongArtifactBundleId(value: string): string {
  return decodePublicId(value, "sab")
}

export function decodePublicSongArtifactUploadId(value: string): string {
  return decodePublicId(value, "sau")
}

export function decodePublicVerificationSessionId(value: string): string {
  return decodePublicId(value, "vs")
}

export function decodePublicUserId(value: string): string {
  const trimmed = value.trim()
  if (!trimmed.startsWith("usr_")) return trimmed
  const stripped = trimmed.slice(4)
  return stripped.includes("_") ? stripped : trimmed
}
