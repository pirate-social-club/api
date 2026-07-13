export type AttemptOutcome = "correct" | "incorrect" | "revealed"
export type FsrsRating = "again" | "hard" | "good" | "easy"

export function normalizeForStudy(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s']/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
}

const IGNORED_RECALL_TOKENS = new Set(["a", "an", "the"])

function expandEnglishContractions(value: string): string {
  return value
    .replace(/\b(can)'t\b/giu, "$1 not")
    .replace(/\b(won)'t\b/giu, "will not")
    .replace(/\b(i)'m\b/giu, "$1 am")
    .replace(/\b([a-z]+)'re\b/giu, "$1 are")
    .replace(/\b([a-z]+)'ve\b/giu, "$1 have")
    .replace(/\b([a-z]+)'ll\b/giu, "$1 will")
    .replace(/\b([a-z]+)'d\b/giu, "$1 would")
    .replace(/\b([a-z]+)'s\b/giu, "$1 is")
}

function normalizeRecallToken(token: string): string {
  const compact = token.replace(/'/gu, "")
  if (compact.length > 4 && compact.endsWith("ies")) return `${compact.slice(0, -3)}y`
  if (compact.length > 4 && /(ches|shes|xes|zes|ses)$/u.test(compact)) return compact.slice(0, -2)
  if (compact.length > 3 && compact.endsWith("s")) return compact.slice(0, -1)
  return compact
}

function recallTokens(value: string): string[] {
  return normalizeForStudy(expandEnglishContractions(value))
    .split(" ")
    .map(normalizeRecallToken)
    .filter((token) => token && !IGNORED_RECALL_TOKENS.has(token))
}

function languageAgnosticRecallTokens(value: string): string[] {
  const normalized = normalizeForStudy(value)
  if (!normalized) return []
  if (/\s/u.test(normalized) || !containsSpacelessScript(normalized)) {
    return normalized.split(" ").filter(Boolean)
  }
  return segmentSpacelessRecallTokens(normalized)
}

export function containsSpacelessScript(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u.test(value)
}

export function segmentSpacelessRecallTokens(value: string): string[] {
  const segmenterConstructor = (Intl as typeof Intl & {
    Segmenter?: new (locale?: string, options?: { granularity?: "grapheme" | "word" | "sentence" }) => {
      segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }>
    }
  }).Segmenter
  if (segmenterConstructor) {
    const words = Array.from(new segmenterConstructor(undefined, { granularity: "word" }).segment(value))
      .filter((segment) => segment.isWordLike !== false)
      .map((segment) => segment.segment.trim())
      .filter(Boolean)
    if (words.length > 1) return words
  }
  return Array.from(value).filter((token) => token.trim())
}

function recallTokensForSourceLanguage(value: string, sourceLanguage: string | null | undefined): string[] {
  return String(sourceLanguage ?? "").toLowerCase().startsWith("en")
    ? recallTokens(value)
    : languageAgnosticRecallTokens(value)
}

function tokenDiff(reference: string, transcript: string, sourceLanguage: string | null | undefined): { matched: string[]; missing: string[]; extra: string[] } {
  const referenceTokens = recallTokensForSourceLanguage(reference, sourceLanguage)
  const transcriptTokens = recallTokensForSourceLanguage(transcript, sourceLanguage)
  const remaining = [...transcriptTokens]
  const matched: string[] = []
  const missing: string[] = []
  for (const token of referenceTokens) {
    const index = remaining.indexOf(token)
    if (index >= 0) {
      matched.push(token)
      remaining.splice(index, 1)
    } else {
      missing.push(token)
    }
  }
  return { matched, missing, extra: remaining }
}

function tokenEditDistance(left: string[], right: string[]): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0]
    previous[0] = leftIndex
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const old = previous[rightIndex]
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1
      previous[rightIndex] = Math.min(previous[rightIndex] + 1, previous[rightIndex - 1] + 1, diagonal + cost)
      diagonal = old
    }
  }
  return previous[right.length] ?? 0
}

export function fsrsRatingFor(outcome: AttemptOutcome, attemptNumber: number): FsrsRating {
  if (outcome === "revealed") return "again"
  if (outcome === "correct" && attemptNumber <= 1) return "good"
  if (outcome === "correct") return "hard"
  return "again"
}

export function gradeSayItBack(input: {
  attemptNumber: number
  reference: string
  sourceLanguage: string | null | undefined
  transcript: string
}): { correct: boolean; feedback: { matched: string[]; missing: string[]; extra: string[] }; rating: FsrsRating } {
  const referenceTokens = recallTokensForSourceLanguage(input.reference, input.sourceLanguage)
  const transcriptTokens = recallTokensForSourceLanguage(input.transcript, input.sourceLanguage)
  const correct = tokenEditDistance(referenceTokens, transcriptTokens) === 0
  return {
    correct,
    feedback: tokenDiff(input.reference, input.transcript, input.sourceLanguage),
    rating: correct ? fsrsRatingFor("correct", input.attemptNumber) : "again",
  }
}
