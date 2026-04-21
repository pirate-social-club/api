import { badRequestError, eligibilityFailed } from "../errors"

const GENERIC_AGENT_DISPLAY_NAMES = new Set(["agent", "openclaw agent"])
const AGENT_HANDLE_SUFFIX = ".clawitzer"
const RESERVED_AGENT_HANDLE_LABELS = new Set([
  "admin",
  "support",
  "pirate",
  "clawitzer",
  "help",
  "mod",
  "staff",
  "official",
  "security",
])

function stripAgentHandleSuffix(value: string): string {
  const trimmed = value.trim().toLowerCase()
  return trimmed.endsWith(AGENT_HANDLE_SUFFIX)
    ? trimmed.slice(0, -AGENT_HANDLE_SUFFIX.length)
    : trimmed
}

export function formatAgentHandleLabel(labelNormalized: string): string {
  return `${labelNormalized}${AGENT_HANDLE_SUFFIX}`
}

export function isReservedAgentHandleLabel(labelNormalized: string): boolean {
  return RESERVED_AGENT_HANDLE_LABELS.has(labelNormalized)
}

export function normalizeDesiredAgentHandleLabel(desiredLabel: string): {
  labelNormalized: string
  labelDisplay: string
} {
  const withoutSuffix = stripAgentHandleSuffix(desiredLabel)

  if (!withoutSuffix || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(withoutSuffix)) {
    throw badRequestError("Invalid desired_label")
  }
  if (isReservedAgentHandleLabel(withoutSuffix)) {
    throw eligibilityFailed("Desired agent handle is reserved")
  }

  return {
    labelNormalized: withoutSuffix,
    labelDisplay: formatAgentHandleLabel(withoutSuffix),
  }
}

export function normalizeAgentHandleLookupLabel(handleLabel: string): string {
  const withoutSuffix = stripAgentHandleSuffix(handleLabel)

  if (!withoutSuffix || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(withoutSuffix)) {
    throw badRequestError("Invalid handle label")
  }
  return withoutSuffix
}

export function slugifyAgentHandleCandidate(value: string): string | null {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\.clawitzer$/iu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-+/gu, "-")
  return normalized && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalized) ? normalized : null
}

export function resolveRequestedAgentDisplayName(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) {
    return null
  }

  if (GENERIC_AGENT_DISPLAY_NAMES.has(trimmed.toLowerCase())) {
    return null
  }

  if (/^agent [a-z0-9]{6}$/iu.test(trimmed)) {
    return null
  }

  return trimmed
}
