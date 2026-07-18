export type ContentTranslationFields = {
  title?: string | null
  body?: string | null
  caption?: string | null
}

export type TranslatedContentFields = {
  translatedTitle?: string | null
  translatedBody?: string | null
  translatedCaption?: string | null
}

const FIELD_PAIRS = [
  ["title", "translatedTitle"],
  ["body", "translatedBody"],
  ["caption", "translatedCaption"],
] as const

export function missingTranslatedContentField(
  source: ContentTranslationFields,
  translated: TranslatedContentFields,
): "translated_title" | "translated_body" | "translated_caption" | null {
  for (const [sourceKey, translatedKey] of FIELD_PAIRS) {
    if (String(source[sourceKey] ?? "").trim() && !String(translated[translatedKey] ?? "").trim()) {
      return translatedKey === "translatedTitle"
        ? "translated_title"
        : translatedKey === "translatedBody"
          ? "translated_body"
          : "translated_caption"
    }
  }
  return null
}

export function hasUsableTranslatedContentFields(
  source: ContentTranslationFields,
  translated: TranslatedContentFields,
): boolean {
  return missingTranslatedContentField(source, translated) === null
}
