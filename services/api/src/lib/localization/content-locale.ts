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
const LATIN_SCRIPT_CHAR_RE = /\p{Script=Latin}/u
const CYRILLIC_SCRIPT_CHAR_RE = /\p{Script=Cyrillic}/u
const WORD_CHAR_SEQUENCE_RE = /[\p{Letter}\p{Mark}]+/gu

// A copied lyric can contain Cyrillic homoglyphs that are visually identical to
// Latin letters (most often Cyrillic "е" inside an otherwise English word).
// Only rewrite a token when it contains both scripts; real Cyrillic words remain
// byte-for-byte unchanged.
const CYRILLIC_TO_LATIN_LOOKALIKE = new Map<string, string>([
  ["А", "A"], ["В", "B"], ["Е", "E"], ["К", "K"], ["М", "M"], ["Н", "H"],
  ["О", "O"], ["Р", "P"], ["С", "C"], ["Т", "T"], ["Х", "X"],
  ["а", "a"], ["е", "e"], ["о", "o"], ["р", "p"], ["с", "c"], ["х", "x"], ["у", "y"],
  ["І", "I"], ["і", "i"], ["Ј", "J"], ["ј", "j"],
])

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

function countScriptCharacters(text: string, pattern: RegExp): number {
  let count = 0
  for (const character of text) {
    if (pattern.test(character)) count += 1
  }
  return count
}

function hasMeaningfulNonLatinScript(text: string, pattern: RegExp): boolean {
  const scriptCount = countScriptCharacters(text, pattern)
  if (scriptCount === 0) return false
  const latinCount = countScriptCharacters(text, LATIN_SCRIPT_CHAR_RE)
  // Pure-script snippets should still detect from a single character. In mixed
  // text, require enough evidence that an isolated pasted character cannot label
  // an entire Latin-script song as another language.
  return latinCount === 0 || (scriptCount >= 3 && scriptCount / (scriptCount + latinCount) >= 0.1)
}

export function normalizeLatinTokenCyrillicLookalikes(value: string): string {
  return value.replace(WORD_CHAR_SEQUENCE_RE, (token) => {
    if (!LATIN_SCRIPT_CHAR_RE.test(token) || !CYRILLIC_SCRIPT_CHAR_RE.test(token)) {
      return token
    }
    return Array.from(token, (character) => CYRILLIC_TO_LATIN_LOOKALIKE.get(character) ?? character).join("")
  })
}

export function detectSourceLanguageFromText(parts: Array<string | null | undefined>): string | null {
  const rawText = parts
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join("\n")

  if (!rawText) {
    return null
  }

  const text = normalizeLatinTokenCyrillicLookalikes(rawText)

  if (ARABIC_CHAR_RE.test(text)) return "ar"
  if (CYRILLIC_CHAR_RE.test(text) && hasMeaningfulNonLatinScript(text, CYRILLIC_CHAR_RE)) return "ru"
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

/**
 * Correct the narrow legacy failure where Cyrillic lookalikes in Latin words
 * caused an English post to be persisted as Russian. Other stored language
 * choices remain authoritative, including genuine Russian and transliteration.
 */
export function resolveStoredSourceLanguage(
  storedLanguage: string | null | undefined,
  parts: Array<string | null | undefined>,
): string | null {
  const stored = normalizeContentLocale(storedLanguage)
  const detected = detectSourceLanguageFromText(parts)
  if (!stored) return null
  if (stored !== "ru" || !detected || detected === "ru") return stored

  const rawText = parts.map((part) => String(part ?? "")).join("\n")
  return normalizeLatinTokenCyrillicLookalikes(rawText) !== rawText ? detected : stored
}
