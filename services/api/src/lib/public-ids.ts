export function decodePublicId(value: string, publicPrefix: string): string {
  const trimmed = value.trim()
  const prefix = `${publicPrefix}_`
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length) : trimmed
}

export function publicCommunityId(rawCommunityId: string): string {
  return rawCommunityId.startsWith("com_") ? rawCommunityId : `com_${rawCommunityId}`
}

export function publicPostId(rawPostId: string): string {
  return rawPostId.startsWith("post_") ? rawPostId : `post_${rawPostId}`
}

export function publicCommentId(rawCommentId: string): string {
  return rawCommentId.startsWith("cmt_") ? rawCommentId : `cmt_${rawCommentId}`
}

export function publicId(rawId: string, publicPrefix: string): string {
  return rawId.startsWith(`${publicPrefix}_`) ? rawId : `${publicPrefix}_${rawId}`
}

export function decodePublicCommunityId(value: string): string {
  return decodePublicId(value, "com")
}

export function decodePublicPostId(value: string): string {
  return decodePublicId(value, "post")
}

export function decodePublicCommentId(value: string): string {
  return decodePublicId(value, "cmt")
}

export function decodePublicAgentId(value: string): string {
  return decodePublicId(value, "agt")
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
  return decodePublicId(value, "nv")
}

export function decodePublicNamespaceVerificationSessionId(value: string): string {
  return decodePublicId(value, "nvs")
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
  return decodePublicId(value, "usr")
}
