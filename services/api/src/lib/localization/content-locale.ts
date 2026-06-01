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

const ARABIC_CHAR_COUNT_RE = /[\u0600-\u06FF]/gu
const CYRILLIC_CHAR_COUNT_RE = /[\u0400-\u04FF]/gu
const DEVANAGARI_CHAR_COUNT_RE = /[\u0900-\u097F]/gu
const HANGUL_CHAR_COUNT_RE = /[\uAC00-\uD7AF]/gu
const HIRAGANA_KATAKANA_COUNT_RE = /[\u3040-\u30FF]/gu
const HAN_CHAR_COUNT_RE = /[\u3400-\u9FFF]/gu
const TRADITIONAL_HAN_HINT_RE = /[體國臺萬與專業樂網說歡龍後這個們]/u
const LATIN_LETTER_RE = /[A-Za-zÀ-ÿ]/
const LETTER_RE = /\p{L}/gu
const WORD_RE = /[\p{L}\p{M}]+/gu
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:\/\S*)?/gu
const MARKDOWN_IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/gu
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\([^)]*\)/gu
const SOCIAL_TOKEN_RE = /(^|\s)[@#][\p{L}\p{M}\p{N}_-]+/gu

const MIN_SCRIPT_LETTER_RATIO = 0.2
const MIN_LATIN_RULE_MATCHES = 3
const MIN_LATIN_RULE_MATCH_WORD_RATIO = 0.05
const NORMALIZED_LANGUAGE_TAG_RE = /^[a-z]{2,3}(?:-[A-Za-z]{4})?(?:-[A-Z]{2})?$/

const DETECTION_RULES: Array<{ locale: string; pattern: RegExp }> = [
  { locale: "es", pattern: /\b(hola|gracias|que|para|con|una|las|los|del|est[aá])\b/giu },
  { locale: "pt-BR", pattern: /\b(olá|você|não|pra|com|uma|que|para|está)\b/giu },
  { locale: "fr", pattern: /\b(bonjour|merci|avec|pour|une|des|est|pas)\b/giu },
  { locale: "de", pattern: /\b(hallo|danke|und|nicht|ist|mit|für|eine)\b/giu },
  { locale: "it", pattern: /\b(ciao|grazie|con|per|una|che|non|sono)\b/giu },
  { locale: "tr", pattern: /\b(merhaba|teşekkür|için|ile|bir|değil|ve)\b/giu },
  { locale: "id", pattern: /\b(halo|terima|kasih|dan|yang|untuk|dengan|ini)\b/giu },
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

export function normalizeDetectedSourceLanguage(sourceLanguage: string | null | undefined): string | null {
  const normalized = normalizeContentLocale(sourceLanguage)
  if (!normalized || !NORMALIZED_LANGUAGE_TAG_RE.test(normalized)) {
    return null
  }
  return normalized
}

function countMatches(text: string, pattern: RegExp): number {
  const matches = text.match(pattern)
  return matches ? matches.length : 0
}

function sanitizeLanguageDetectionText(text: string): string {
  return text
    .replace(MARKDOWN_IMAGE_RE, " ")
    .replace(MARKDOWN_LINK_RE, "$1")
    .replace(URL_RE, " ")
    .replace(SOCIAL_TOKEN_RE, " ")
}

function countLetters(text: string): number {
  return countMatches(text, LETTER_RE)
}

function countWords(text: string): number {
  return countMatches(text, WORD_RE)
}

function dominantScriptLocale(text: string, totalLetters: number): string | null {
  const candidates: Array<{ locale: string; pattern: RegExp }> = [
    { locale: "ar", pattern: ARABIC_CHAR_COUNT_RE },
    { locale: "ru", pattern: CYRILLIC_CHAR_COUNT_RE },
    { locale: "hi", pattern: DEVANAGARI_CHAR_COUNT_RE },
    { locale: "ko", pattern: HANGUL_CHAR_COUNT_RE },
    { locale: "ja", pattern: HIRAGANA_KATAKANA_COUNT_RE },
    { locale: "zh-Hans", pattern: HAN_CHAR_COUNT_RE },
  ]

  for (const candidate of candidates) {
    const scriptLetters = countMatches(text, candidate.pattern)
    if (scriptLetters > 0 && scriptLetters / totalLetters >= MIN_SCRIPT_LETTER_RATIO) {
      if (candidate.locale === "zh-Hans") {
        return TRADITIONAL_HAN_HINT_RE.test(text) ? "zh-Hant" : "zh-Hans"
      }
      return candidate.locale
    }
  }

  return null
}

export function detectSourceLanguageFromText(parts: Array<string | null | undefined>): string | null {
  const text = parts
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join("\n")

  if (!text) {
    return null
  }

  const sanitized = sanitizeLanguageDetectionText(text)
  const totalLetters = countLetters(sanitized)
  if (totalLetters === 0) {
    return null
  }

  const scriptLocale = dominantScriptLocale(sanitized, totalLetters)
  if (scriptLocale) {
    return scriptLocale
  }

  if (!LATIN_LETTER_RE.test(sanitized)) {
    return null
  }

  const lowered = toLowerTrimmed(sanitized)
  const totalWords = Math.max(countWords(lowered), 1)
  let bestLocale: string | null = null
  let bestScore = 0

  for (const rule of DETECTION_RULES) {
    const score = countMatches(lowered, rule.pattern)
    if (score > bestScore) {
      bestLocale = rule.locale
      bestScore = score
    }
  }

  if (
    bestScore >= MIN_LATIN_RULE_MATCHES
    && bestScore / totalWords > MIN_LATIN_RULE_MATCH_WORD_RATIO
  ) {
    return bestLocale
  }

  return "en"
}
