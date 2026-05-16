export function cleanProviderText(value: unknown): string {
  if (typeof value !== "string") {
    return ""
  }
  return value.replace(/\s+/g, " ").trim()
}

export function cleanNullableProviderText(value: unknown): string | null {
  const cleaned = cleanProviderText(value)
  return cleaned || null
}

export function requireProviderMaxLength(input: {
  value: string
  maxLength: number
  fieldName: string
  errorPrefix: string
}): void {
  if (input.value.length > input.maxLength) {
    throw new Error(`${input.errorPrefix}: ${input.fieldName} too long`)
  }
}

export function parseProviderKeyPoints(input: {
  value: unknown
  maxLength: number
  errorPrefix: string
}): string[] {
  const keyPoints = Array.isArray(input.value)
    ? input.value
      .map((point) => cleanProviderText(point))
      .filter(Boolean)
      .slice(0, 3)
    : []

  if (keyPoints.length !== 3) {
    throw new Error(`${input.errorPrefix}: expected exactly three key_points`)
  }
  for (const point of keyPoints) {
    requireProviderMaxLength({
      value: point,
      maxLength: input.maxLength,
      fieldName: "key_points",
      errorPrefix: input.errorPrefix,
    })
  }
  return keyPoints
}
