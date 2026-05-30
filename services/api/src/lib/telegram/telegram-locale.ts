export const RUNTIME_UI_LOCALES = ["en", "ar", "zh", "ka"] as const

export type RuntimeUiLocaleCode = (typeof RUNTIME_UI_LOCALES)[number]

export function resolveRuntimeUiLocale(value: string | null | undefined): RuntimeUiLocaleCode | null {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) {
    return null
  }
  if (normalized === "en" || normalized.startsWith("en-")) {
    return "en"
  }
  if (normalized === "ar" || normalized.startsWith("ar-")) {
    return "ar"
  }
  if (normalized === "zh" || normalized.startsWith("zh-")) {
    return "zh"
  }
  if (normalized === "ka" || normalized.startsWith("ka-")) {
    return "ka"
  }
  return null
}

export function resolveTelegramStartLocale(input: {
  profilePreferredLocale?: string | null
  telegramLanguageCode?: string | null
}): RuntimeUiLocaleCode {
  return resolveRuntimeUiLocale(input.telegramLanguageCode)
    ?? resolveRuntimeUiLocale(input.profilePreferredLocale)
    ?? "en"
}
