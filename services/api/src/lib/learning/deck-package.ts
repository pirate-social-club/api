import { sha256Hex } from "../crypto"

export const LEARNING_DECK_SCHEMA_VERSION = 1 as const
export const DECK_IMPORT_MAX_BYTES = 10 * 1024 * 1024
export const DECK_IMPORT_MAX_ROWS = 10_000
export const DECK_MAX_CARDS = 10_000
export const DECK_MAX_COLUMNS = 32
export const DECK_MAX_CELL_CODE_UNITS = 16 * 1024
export const DECK_MAX_PROMPT_OR_ANSWER_CODE_UNITS = 16 * 1024
export const DECK_MAX_TAGS = 32
export const DECK_MAX_CANONICAL_PACKAGE_BYTES = 50 * 1024 * 1024

export type LearningCardType = "basic" | "cloze"

export type LearningCardInput = {
  cardId: string
  cardType: LearningCardType
  prompt: string
  answer: string
  tags?: string[]
}

export type CanonicalLearningCard = {
  card_id: string
  ordinal: number
  card_type: LearningCardType
  prompt: string
  answer: string
  tags: string[]
}

export type CanonicalLearningDeck = {
  schema_version: typeof LEARNING_DECK_SCHEMA_VERSION
  title: string
  description: string | null
  cards: CanonicalLearningCard[]
}

export type DeckValidationIssue = {
  code:
  | "title_required"
  | "cards_required"
  | "too_many_cards"
  | "card_id_invalid"
  | "card_type_invalid"
  | "prompt_required"
  | "answer_required"
  | "text_unsafe"
  | "text_too_long"
  | "too_many_tags"
  | "tag_invalid"
  | "cloze_group_invalid"
  message: string
  cardIndex?: number
  field?: "title" | "description" | "card_id" | "prompt" | "answer" | "tag"
}

export type DeckCsvRowError = {
  row: number
  code: "invalid_csv" | "too_many_columns" | "cell_too_long" | "empty_prompt" | "empty_answer"
  message: string
}

export type DeckCsvParseResult = {
  headers: string[]
  rows: string[][]
  errors: DeckCsvRowError[]
}

function normalizeText(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/g, "\n")
}

function isUnsafeText(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code === 0 || (code < 0x20 && code !== 0x09 && code !== 0x0a)) return true
    if (code >= 0x7f && code <= 0x9f) return true
  }
  return false
}

function validateText(
  value: string,
  cardIndex: number | undefined,
  field: DeckValidationIssue["field"],
  requiredCode: "prompt_required" | "answer_required",
): DeckValidationIssue[] {
  const normalized = normalizeText(value)
  if (!normalized.trim()) {
    return [{ code: requiredCode, message: `${field} is required`, cardIndex, field }]
  }
  if (normalized.length > DECK_MAX_PROMPT_OR_ANSWER_CODE_UNITS) {
    return [{ code: "text_too_long", message: `${field} exceeds the 16 KiB limit`, cardIndex, field }]
  }
  if (isUnsafeText(normalized)) {
    return [{ code: "text_unsafe", message: `${field} contains unsupported control characters`, cardIndex, field }]
  }
  return []
}

function validateCloze(prompt: string, answer: string, cardIndex: number): DeckValidationIssue[] {
  const groups = [...`${prompt}\n${answer}`.matchAll(/\{\{c(\d+)::/g)]
  if (groups.length !== 1 || groups[0]?.[1] !== "1") {
    return [{
      code: "cloze_group_invalid",
      message: "cloze cards must contain exactly one {{c1::...}} group",
      cardIndex,
    }]
  }
  return []
}

export function validateLearningDeck(input: {
  title: string
  description?: string | null
  cards: LearningCardInput[]
}): DeckValidationIssue[] {
  const issues: DeckValidationIssue[] = []
  const title = normalizeText(input.title)
  if (!title.trim()) issues.push({ code: "title_required", message: "title is required", field: "title" })
  else if (title.length > DECK_MAX_PROMPT_OR_ANSWER_CODE_UNITS) {
    issues.push({ code: "text_too_long", message: "title exceeds the 16 KiB limit", field: "title" })
  } else if (isUnsafeText(title)) {
    issues.push({ code: "text_unsafe", message: "title contains unsupported control characters", field: "title" })
  }
  if (input.description != null) {
    const description = normalizeText(input.description)
    if (description.length > DECK_MAX_PROMPT_OR_ANSWER_CODE_UNITS) {
      issues.push({ code: "text_too_long", message: "description exceeds the 16 KiB limit", field: "description" })
    } else if (isUnsafeText(description)) {
      issues.push({ code: "text_unsafe", message: "description contains unsupported control characters", field: "description" })
    }
  }
  if (!input.cards.length) issues.push({ code: "cards_required", message: "at least one card is required" })
  if (input.cards.length > DECK_MAX_CARDS) {
    issues.push({ code: "too_many_cards", message: `decks are limited to ${DECK_MAX_CARDS} cards` })
  }

  const seenIds = new Set<string>()
  input.cards.slice(0, DECK_MAX_CARDS).forEach((card, cardIndex) => {
    const cardId = card.cardId.trim()
    if (!/^lcd_[A-Za-z0-9_-]{1,128}$/.test(cardId) || seenIds.has(cardId)) {
      issues.push({ code: "card_id_invalid", message: "card id must be unique and use the lcd_ prefix", cardIndex, field: "card_id" })
    }
    seenIds.add(cardId)
    if (card.cardType !== "basic" && card.cardType !== "cloze") {
      issues.push({ code: "card_type_invalid", message: "card type is unsupported", cardIndex })
    }
    const prompt = normalizeText(card.prompt)
    const answer = normalizeText(card.answer)
    issues.push(...validateText(prompt, cardIndex, "prompt", "prompt_required"))
    issues.push(...validateText(answer, cardIndex, "answer", "answer_required"))
    if (card.cardType === "cloze") issues.push(...validateCloze(prompt, answer, cardIndex))
    const tags = card.tags ?? []
    if (tags.length > DECK_MAX_TAGS) {
      issues.push({ code: "too_many_tags", message: `cards are limited to ${DECK_MAX_TAGS} tags`, cardIndex, field: "tag" })
    }
    for (const tag of tags.slice(0, DECK_MAX_TAGS)) {
      const normalizedTag = normalizeText(tag)
      if (!normalizedTag.trim() || normalizedTag.length > 256 || isUnsafeText(normalizedTag)) {
        issues.push({ code: "tag_invalid", message: "tag is empty, too long, or contains unsupported characters", cardIndex, field: "tag" })
      }
    }
  })
  return issues
}

export function buildCanonicalLearningDeck(input: {
  title: string
  description?: string | null
  cards: LearningCardInput[]
}): CanonicalLearningDeck {
  const issues = validateLearningDeck(input)
  if (issues.length) throw new Error(issues[0]?.message ?? "learning deck validation failed")
  return {
    schema_version: LEARNING_DECK_SCHEMA_VERSION,
    title: normalizeText(input.title),
    description: input.description == null ? null : normalizeText(input.description),
    cards: input.cards.map((card, ordinal) => ({
      card_id: card.cardId.trim(),
      ordinal,
      card_type: card.cardType,
      prompt: normalizeText(card.prompt),
      answer: normalizeText(card.answer),
      tags: (card.tags ?? []).map(normalizeText).sort(),
    })),
  }
}

export function canonicalLearningDeckJson(deck: CanonicalLearningDeck): string {
  // Object construction order is explicit and stable; do not replace this
  // with a generic serializer whose key ordering can change across runtimes.
  return JSON.stringify({
    schema_version: deck.schema_version,
    title: deck.title,
    description: deck.description,
    cards: deck.cards.map((card) => ({
      card_id: card.card_id,
      ordinal: card.ordinal,
      card_type: card.card_type,
      prompt: card.prompt,
      answer: card.answer,
      tags: card.tags,
    })),
  })
}

export async function canonicalLearningDeckPackage(input: {
  title: string
  description?: string | null
  cards: LearningCardInput[]
}): Promise<{
  deck: CanonicalLearningDeck
  json: string
  bytes: Uint8Array
  contentHash: `0x${string}`
}> {
  const deck = buildCanonicalLearningDeck(input)
  const json = canonicalLearningDeckJson(deck)
  const bytes = new TextEncoder().encode(json)
  if (bytes.byteLength > DECK_MAX_CANONICAL_PACKAGE_BYTES) {
    throw new Error("canonical learning deck package exceeds the 50 MiB limit")
  }
  return {
    deck,
    json,
    bytes,
    contentHash: `0x${await sha256Hex(bytes)}`,
  }
}

/** Parse bounded RFC-4180-like CSV without evaluating formulas or URLs. */
export function parseLearningDeckCsv(input: string): DeckCsvParseResult {
  const bytes = new TextEncoder().encode(input)
  if (bytes.byteLength > DECK_IMPORT_MAX_BYTES) {
    return { headers: [], rows: [], errors: [{ row: 0, code: "invalid_csv", message: "CSV import exceeds the 10 MiB limit" }] }
  }
  const rows: string[][] = []
  const errors: DeckCsvRowError[] = []
  let row: string[] = []
  let field = ""
  let inQuotes = false
  let rowNumber = 1
  const pushField = () => {
    if (field.length > DECK_MAX_CELL_CODE_UNITS) {
      errors.push({ row: rowNumber, code: "cell_too_long", message: "CSV cell exceeds the 16 KiB limit" })
    }
    row.push(normalizeText(field))
    field = ""
  }
  const pushRow = () => {
    pushField()
    if (row.length > DECK_MAX_COLUMNS) {
      errors.push({ row: rowNumber, code: "too_many_columns", message: `CSV rows are limited to ${DECK_MAX_COLUMNS} columns` })
    }
    rows.push(row)
    row = []
    rowNumber += 1
  }
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]
    if (inQuotes) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"'
          index += 1
        } else {
          inQuotes = false
        }
      } else {
        field += character
      }
      continue
    }
    if (character === '"' && field.length === 0) {
      inQuotes = true
    } else if (character === ",") {
      pushField()
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && input[index + 1] === "\n") index += 1
      pushRow()
    } else {
      field += character
    }
  }
  if (inQuotes) errors.push({ row: rowNumber, code: "invalid_csv", message: "CSV contains an unterminated quoted field" })
  if (field.length || row.length) pushRow()
  if (rows.length > DECK_IMPORT_MAX_ROWS + 1) {
    errors.push({ row: 0, code: "invalid_csv", message: `CSV is limited to ${DECK_IMPORT_MAX_ROWS} data rows` })
  }
  const [headers = [], ...dataRows] = rows
  return { headers, rows: dataRows.slice(0, DECK_IMPORT_MAX_ROWS), errors }
}
