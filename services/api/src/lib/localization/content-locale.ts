const CONTENT_LOCALE_ALIAS_MAP = new Map<string, string>([
  ["en-us", "en"],
  ["en-gb", "en"],
  ["es-es", "es"],
  ["es-419", "es"],
  ["pt", "pt-BR"],
  ["pt-br", "pt-BR"],
  ["zh", "zh-Hans"],
  ["zh-cn", "zh-Hans"],
  ["zh-sg", "zh-Hans"],
  ["zh-hans", "zh-Hans"],
  ["zh-tw", "zh-Hant"],
  ["zh-hk", "zh-Hant"],
  ["zh-mo", "zh-Hant"],
  ["zh-hant", "zh-Hant"],
])

export const DEFAULT_CONTENT_LOCALE = "en"

export const CONTENT_TRANSLATION_PREWARM_LOCALES = [
  "en",
  "es",
  "pt-BR",
  "zh-Hans",
  "zh-Hant",
  "ja",
  "ko",
  "fr",
  "de",
  "ar",
  "hi",
  "ru",
  "id",
  "it",
  "tr",
] as const

const ARABIC_CHAR_RE = /[\u0600-\u06FF]/
const CYRILLIC_CHAR_RE = /[\u0400-\u04FF]/
const DEVANAGARI_CHAR_RE = /[\u0900-\u097F]/
const HANGUL_CHAR_RE = /[\uAC00-\uD7AF]/
const HIRAGANA_KATAKANA_RE = /[\u3040-\u30FF]/
const HAN_CHAR_RE = /[\u3400-\u9FFF]/
const TRADITIONAL_HAN_HINT_RE = /[體國臺萬與專業樂網說歡龍後這個們]/u
const LATIN_LETTER_RE = /[A-Za-zÀ-ÿ]/

const DETECTION_RULES: Array<{ locale: string; pattern: RegExp }> = [
  { locale: "es", pattern: /\b(hola|gracias|que|para|con|una|las|los|del|est[aá])\b/giu },
  { locale: "pt-BR", pattern: /\b(olá|você|não|pra|com|uma|que|para|está)\b/giu },
  { locale: "fr", pattern: /\b(bonjour|merci|avec|pour|une|des|est|pas)\b/giu },
  { locale: "de", pattern: /\b(hallo|danke|und|nicht|ist|mit|für|eine)\b/giu },
  { locale: "it", pattern: /\b(ciao|grazie|con|per|una|che|non|sono)\b/giu },
  { locale: "tr", pattern: /\b(merhaba|teşekkür|için|ile|bir|değil|ve)\b/giu },
  { locale: "id", pattern: /\b(halo|terima|kasih|dan|yang|untuk|dengan|ini)\b/giu },
  // English is scored last so ties resolve to a more specific language above; without a
  // rule of its own English text can only ever reach the score-0 fallback and loses to
  // any incidental foreign-stopword match.
  { locale: "en", pattern: /\b(the|and|you|are|for|with|this|that|have|not|but|your|from|they|will|would|could|should|been|were|what|when)\b/giu },
]

function toLowerTrimmed(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase()
}

export function normalizeContentLocale(locale: string | null | undefined): string | null {
  const trimmed = String(locale ?? "").trim()
  if (!trimmed) {
    return null
  }

  const lowered = trimmed.replace(/_/g, "-").toLowerCase()
  const aliased = CONTENT_LOCALE_ALIAS_MAP.get(lowered)
  if (aliased) {
    return aliased
  }

  const [language, ...rest] = lowered.split("-").filter(Boolean)
  if (!language) {
    return null
  }

  if (language === "pt") {
    return "pt-BR"
  }
  if (language === "zh") {
    return "zh-Hans"
  }
  if (rest.length === 0) {
    return language
  }

  return [language, ...rest.map((segment) => {
    if (segment.length === 4) {
      return segment[0]!.toUpperCase() + segment.slice(1)
    }
    return segment.toUpperCase()
  })].join("-")
}

export function sameLanguageLocale(sourceLanguage: string | null | undefined, targetLocale: string | null | undefined): boolean {
  const normalizedSource = normalizeContentLocale(sourceLanguage)
  const normalizedTarget = normalizeContentLocale(targetLocale)
  if (!normalizedSource || !normalizedTarget) {
    return false
  }
  if (normalizedSource === normalizedTarget) {
    return true
  }
  if (normalizedSource.startsWith("zh-") || normalizedTarget.startsWith("zh-")) {
    return normalizedSource === normalizedTarget || normalizedSource === "zh-Hans" && normalizedTarget === "zh"
  }
  return normalizedSource.split("-")[0] === normalizedTarget.split("-")[0]
}

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern)
  return matches ? matches.length : 0
}

export function detectSourceLanguageFromText(parts: Array<string | null | undefined>): string | null {
  const text = parts
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join("\n")

  if (!text) {
    return null
  }

  if (ARABIC_CHAR_RE.test(text)) return "ar"
  if (CYRILLIC_CHAR_RE.test(text)) return "ru"
  if (DEVANAGARI_CHAR_RE.test(text)) return "hi"
  if (HANGUL_CHAR_RE.test(text)) return "ko"
  if (HIRAGANA_KATAKANA_RE.test(text)) return "ja"
  if (HAN_CHAR_RE.test(text)) {
    return TRADITIONAL_HAN_HINT_RE.test(text) ? "zh-Hant" : "zh-Hans"
  }

  if (!LATIN_LETTER_RE.test(text)) {
    return null
  }

  // Strip English enclitic contractions ("I've", "you're", "don't", "she'll") before
  // stopword matching. The apostrophe is a regex word boundary, so the contraction tail
  // otherwise matches short foreign stopwords — most damagingly Turkish "ve" ("and"),
  // which mislabelled English songs full of "I've/we've/…" as Turkish (source_language=tr)
  // and silently broke their Study generation. Real space-delimited "ve" is untouched.
  const lowered = toLowerTrimmed(text).replace(/['’](ve|re|ll|d|s|m|t)\b/g, "")
  let bestLocale: string | null = null
  let bestScore = 0

  for (const rule of DETECTION_RULES) {
    const score = countMatches(lowered, rule.pattern)
    if (score > bestScore) {
      bestLocale = rule.locale
      bestScore = score
    }
  }

  if (bestScore >= 2) {
    return bestLocale
  }

  return "en"
}
