const ANONYMOUS_ADJECTIVES = [
  "amber",
  "brisk",
  "cinder",
  "distant",
  "ember",
  "fable",
  "granite",
  "harbor",
  "ivory",
  "jade",
  "keel",
  "lunar",
  "marble",
  "north",
  "onyx",
  "signal",
] as const

const ANONYMOUS_NOUNS = [
  "anchor",
  "beacon",
  "corsair",
  "deck",
  "echo",
  "flag",
  "gale",
  "harpoon",
  "isle",
  "jetty",
  "keystone",
  "lantern",
  "mast",
  "narwhal",
  "oar",
  "port",
] as const

function hashSeed(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index)
    hash |= 0
  }
  return Math.abs(hash)
}

function toTitleCase(value: string): string {
  return value
    .split(/[_\s-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ")
}

export function buildAnonymousLabel(input: {
  communityId: string
  entityId: string
  scope: "community_stable" | "thread_stable" | "post_ephemeral"
  userId: string
}): string {
  const seed = input.scope === "community_stable"
    ? `${input.communityId}:${input.userId}`
    : `${input.entityId}:${input.userId}`
  const hash = hashSeed(seed)
  const adjective = ANONYMOUS_ADJECTIVES[hash % ANONYMOUS_ADJECTIVES.length]
  const noun = ANONYMOUS_NOUNS[Math.floor(hash / ANONYMOUS_ADJECTIVES.length) % ANONYMOUS_NOUNS.length]
  const suffix = (Math.floor(hash / (ANONYMOUS_ADJECTIVES.length * ANONYMOUS_NOUNS.length)) % 100).toString().padStart(2, "0")

  return `anon_${adjective}-${noun}-${suffix}`
}

export function formatDisclosedQualifierLabel(qualifierTemplateId: string): string {
  const trimmed = qualifierTemplateId.trim()
  if (!trimmed) {
    return "Qualifier"
  }

  const normalized = trimmed
    .replace(/^qlf_/i, "")
    .replace(/^vc_/i, "")
    .replace(/^proof_/i, "")

  if (normalized === "age_over_18") {
    return "18+"
  }
  if (normalized === "unique_human") {
    return "Unique Human"
  }
  if (normalized === "sanctions_clear") {
    return "Sanctions Clear"
  }

  return toTitleCase(normalized)
}

export function buildDisclosedQualifierSnapshots(
  qualifierTemplateIds: readonly string[] | null | undefined,
): Array<{
  qualifier_template_id: string
  rendered_label: string
  qualifier_kind: "verification_capability" | "provider_attestation"
  qualifier_source: string
  sensitivity_level?: "low" | "high" | null
  redundancy_key?: string | null
}> | null {
  if (!qualifierTemplateIds?.length) {
    return null
  }

  const uniqueQualifierIds = [...new Set(
    qualifierTemplateIds
      .map((qualifierTemplateId) => qualifierTemplateId.trim())
      .filter(Boolean),
  )]

  if (!uniqueQualifierIds.length) {
    return null
  }

  return uniqueQualifierIds.map((qualifierTemplateId) => ({
    qualifier_template_id: qualifierTemplateId,
    rendered_label: formatDisclosedQualifierLabel(qualifierTemplateId),
    qualifier_kind: "verification_capability",
    qualifier_source: "community_post",
    sensitivity_level: null,
    redundancy_key: null,
  }))
}
