const COMMUNITY_COUNTRY_CODE_PATTERN = /^[a-z]{2}$/u

export function normalizeCommunityCountryCode(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : ""
  return COMMUNITY_COUNTRY_CODE_PATTERN.test(normalized) ? normalized : null
}

export function isValidCommunityCountryCode(value: unknown): boolean {
  return normalizeCommunityCountryCode(value) !== null
}
