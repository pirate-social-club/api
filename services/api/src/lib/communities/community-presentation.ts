import type { CommunityBranding, CommunityPresentationPatch } from "@pirate/api-contracts"
import { badRequestError } from "../errors"

export type { CommunityPresentationPatch } from "@pirate/api-contracts"

export type CommunityDefaultSurface = "threads" | "videos"

export type CommunityPresentation = {
  branding: CommunityBranding
  default_surface: CommunityDefaultSurface
}

const BRANDING_KEYS = new Set(["accent_color", "header_style", "tagline", "theme"])
const PRESENTATION_KEYS = new Set(["branding", "default_surface"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function parseStoredBranding(value: string): Partial<CommunityBranding> {
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) ? parsed as Partial<CommunityBranding> : {}
  } catch {
    return {}
  }
}

export function normalizeCommunityBranding(value: string): CommunityBranding {
  const parsed = parseStoredBranding(value)
  return {
    accent_color: typeof parsed.accent_color === "string" && /^#[0-9a-f]{6}$/iu.test(parsed.accent_color)
      ? parsed.accent_color.toUpperCase()
      : null,
    header_style: parsed.header_style === "compact" || parsed.header_style === "immersive"
      ? parsed.header_style
      : "standard",
    tagline: typeof parsed.tagline === "string" && parsed.tagline.trim()
      ? parsed.tagline.trim().slice(0, 120)
      : null,
    theme: parsed.theme === "light" || parsed.theme === "dark" ? parsed.theme : "system",
  }
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
  const linear = channels.map((channel) => channel <= 0.04045
    ? channel / 12.92
    : Math.pow((channel + 0.055) / 1.055, 2.4))
  return 0.2126 * (linear[0] ?? 0) + 0.7152 * (linear[1] ?? 0) + 0.0722 * (linear[2] ?? 0)
}

function contrastRatio(left: number, right: number): number {
  const lighter = Math.max(left, right)
  const darker = Math.min(left, right)
  return (lighter + 0.05) / (darker + 0.05)
}

function assertAccentContrast(accentColor: string, theme: CommunityBranding["theme"]): void {
  const accent = relativeLuminance(accentColor)
  const backgrounds = theme === "light"
    ? [1]
    : theme === "dark"
      ? [relativeLuminance("#0E0F11")]
      : [1, relativeLuminance("#0E0F11")]
  if (backgrounds.some((background) => contrastRatio(accent, background) < 3)) {
    throw badRequestError("branding.accent_color must meet 3:1 contrast for the selected theme")
  }
}

export function assertCommunityPresentationPatch(
  value: CommunityPresentationPatch | null,
  current: CommunityPresentation,
): CommunityPresentation {
  if (!isRecord(value)) {
    throw badRequestError("Invalid community presentation payload")
  }
  for (const key of Object.keys(value)) {
    if (!PRESENTATION_KEYS.has(key)) throw badRequestError(`Unknown community presentation field: ${key}`)
  }
  if (value.default_surface !== undefined && value.default_surface !== "threads" && value.default_surface !== "videos") {
    throw badRequestError("default_surface is invalid")
  }
  if (value.branding !== undefined && !isRecord(value.branding)) {
    throw badRequestError("branding is invalid")
  }
  const brandingPatch = value.branding ?? {}
  for (const key of Object.keys(brandingPatch)) {
    if (!BRANDING_KEYS.has(key)) throw badRequestError(`Unknown branding field: ${key}`)
  }

  const theme = brandingPatch.theme ?? current.branding.theme
  if (theme !== "system" && theme !== "light" && theme !== "dark") {
    throw badRequestError("branding.theme is invalid")
  }
  const headerStyle = brandingPatch.header_style ?? current.branding.header_style
  if (headerStyle !== "standard" && headerStyle !== "compact" && headerStyle !== "immersive") {
    throw badRequestError("branding.header_style is invalid")
  }
  const accentColor = brandingPatch.accent_color === undefined
    ? current.branding.accent_color
    : brandingPatch.accent_color
  if (accentColor !== null && (typeof accentColor !== "string" || !/^#[0-9a-f]{6}$/iu.test(accentColor))) {
    throw badRequestError("branding.accent_color must be a six-digit hex color")
  }
  const normalizedAccentColor = accentColor?.toUpperCase() ?? null
  if (normalizedAccentColor) assertAccentContrast(normalizedAccentColor, theme)

  const tagline = brandingPatch.tagline === undefined ? current.branding.tagline : brandingPatch.tagline
  if (tagline !== null && typeof tagline !== "string") {
    throw badRequestError("branding.tagline must be a string or null")
  }
  const normalizedTagline = tagline?.trim() || null
  if (normalizedTagline && normalizedTagline.length > 120) {
    throw badRequestError("branding.tagline must be at most 120 characters")
  }

  return {
    branding: {
      accent_color: normalizedAccentColor,
      header_style: headerStyle,
      tagline: normalizedTagline,
      theme,
    },
    default_surface: value.default_surface ?? current.default_surface,
  }
}

export function communityPresentationFromRow(input: {
  branding_json: string
  default_surface: CommunityDefaultSurface
}): CommunityPresentation {
  return {
    branding: normalizeCommunityBranding(input.branding_json),
    default_surface: input.default_surface === "videos" ? "videos" : "threads",
  }
}
