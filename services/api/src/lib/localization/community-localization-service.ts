import type {
  Community,
  CommunityPreview,
  CommunityTextLocalization,
  CommunityTextLocalizationItem,
  Env,
} from "../../types"
import { enqueueCommunityJob } from "../communities/community-job-store"
import type { DbExecutor } from "../db-helpers"
import { nowIso } from "../helpers"
import {
  type CommunityLocalizationMetaRecord,
  upsertCommunityLocalizationMeta,
  listCommunityLocalizationMeta,
} from "./community-localization-meta-store"
import { DEFAULT_CONTENT_LOCALE, detectSourceLanguageFromText, normalizeContentLocale, sameLanguageLocale } from "./content-locale"
import { requestContentTranslation } from "./content-translation-provider"
import { computeTextSourceHash } from "./content-source-hash"
import { getContentTranslation, upsertContentTranslation, type ContentTranslationRecord } from "./content-translation-store"

type CommunityTextField = {
  field_key: string
  source_text: string
}

type CommunityTextMaterializePayload = {
  locale?: string | null
}

function hasTranslatedBody(record: ContentTranslationRecord | null): boolean {
  if (!record || record.outcome !== "translated") {
    return false
  }
  return Boolean(String(record.translated_body ?? "").trim())
}

function collectCommunityFields(community: Community): CommunityTextField[] {
  const fields: CommunityTextField[] = []

  if (String(community.description ?? "").trim()) {
    fields.push({
      field_key: "community.description",
      source_text: String(community.description).trim(),
    })
  }

  for (const rule of community.community_profile?.rules ?? []) {
    const title = String(rule.title ?? "").trim()
    if (title) {
      fields.push({
        field_key: `community.rule.${rule.rule_id}.title`,
        source_text: title,
      })
    }

    const body = String(rule.body ?? "").trim()
    if (body) {
      fields.push({
        field_key: `community.rule.${rule.rule_id}.body`,
        source_text: body,
      })
    }
  }

  for (const link of community.reference_links ?? []) {
    const label = String(link.label ?? "").trim()
    if (label) {
      fields.push({
        field_key: `community.reference_link.${link.community_reference_link_id}.label`,
        source_text: label,
      })
    }

    const displayName = String(link.metadata?.display_name ?? "").trim()
    if (displayName) {
      fields.push({
        field_key: `community.reference_link.${link.community_reference_link_id}.metadata.display_name`,
        source_text: displayName,
      })
    }
  }

  return fields
}

function collectPreviewFields(preview: CommunityPreview): CommunityTextField[] {
  const fields: CommunityTextField[] = []
  const description = String(preview.description ?? "").trim()
  if (description) {
    fields.push({
      field_key: "community.description",
      source_text: description,
    })
  }

  for (const rule of preview.rules ?? []) {
    const title = String(rule.title ?? "").trim()
    if (title) {
      fields.push({
        field_key: `community.rule.${rule.rule_id}.title`,
        source_text: title,
      })
    }

    const body = String(rule.body ?? "").trim()
    if (body) {
      fields.push({
        field_key: `community.rule.${rule.rule_id}.body`,
        source_text: body,
      })
    }
  }

  return fields
}

async function ensureCommunityLocalizationMeta(input: {
  executor: DbExecutor
  communityId: string
  fields: CommunityTextField[]
}): Promise<Map<string, CommunityLocalizationMetaRecord>> {
  const existing = await listCommunityLocalizationMeta({
    executor: input.executor,
    communityId: input.communityId,
  })
  const records = new Map(existing)
  const now = nowIso()

  for (const field of input.fields) {
    const sourceHash = await computeTextSourceHash(field.source_text)
    const current = records.get(field.field_key)
    if (current && current.source_hash === sourceHash) {
      continue
    }

    const sourceLanguage = detectSourceLanguageFromText([field.source_text])
    const translationPolicy = current?.translation_policy ?? "machine_allowed"
    await upsertCommunityLocalizationMeta({
      executor: input.executor,
      communityId: input.communityId,
      fieldKey: field.field_key,
      sourceHash,
      sourceLanguage,
      translationPolicy,
      now,
    })

    records.set(field.field_key, {
      community_localization_meta_id: current?.community_localization_meta_id ?? `pending_${field.field_key}`,
      community_id: input.communityId,
      field_key: field.field_key,
      source_hash: sourceHash,
      source_language: sourceLanguage,
      translation_policy: translationPolicy,
      created_at: current?.created_at ?? now,
      updated_at: now,
    })
  }

  return records
}

async function buildCommunityTextLocalizationInternal(input: {
  executor: DbExecutor
  communityId: string
  locale?: string | null
  fields: CommunityTextField[]
}): Promise<CommunityTextLocalization> {
  const resolvedLocale = normalizeContentLocale(input.locale) ?? DEFAULT_CONTENT_LOCALE
  const metadata = await ensureCommunityLocalizationMeta({
    executor: input.executor,
    communityId: input.communityId,
    fields: input.fields,
  })

  const items: CommunityTextLocalizationItem[] = []
  for (const field of input.fields) {
    const meta = metadata.get(field.field_key)
    if (!meta) {
      continue
    }

    const item: CommunityTextLocalizationItem = {
      field_key: field.field_key,
      source_hash: meta.source_hash,
      translation_state: "same_language",
      machine_translated: false,
      translated_value: null,
    }

    if (sameLanguageLocale(meta.source_language, resolvedLocale)) {
      items.push(item)
      continue
    }

    if (meta.translation_policy === "none" || meta.translation_policy === "human_only") {
      items.push({
        ...item,
        translation_state: "policy_blocked",
      })
      continue
    }

    const cached = await getContentTranslation({
      executor: input.executor,
      contentType: "community_text",
      contentId: input.communityId,
      fieldKey: field.field_key,
      locale: resolvedLocale,
      sourceHash: meta.source_hash,
    })

    if (!cached) {
      items.push({
        ...item,
        translation_state: "pending",
      })
      continue
    }

    if (cached.outcome === "same_language") {
      items.push(item)
      continue
    }

    items.push({
      ...item,
      translation_state: "ready",
      machine_translated: true,
      translated_value: cached.translated_body,
    })
  }

  return {
    resolved_locale: resolvedLocale,
    items,
  }
}

export async function buildLocalizedCommunity(input: {
  executor: DbExecutor
  community: Community
  locale?: string | null
}): Promise<Community> {
  const localizedText = await buildCommunityTextLocalizationInternal({
    executor: input.executor,
    communityId: input.community.community_id,
    locale: input.locale,
    fields: collectCommunityFields(input.community),
  })

  return {
    ...input.community,
    localized_text: localizedText,
  }
}

export async function buildLocalizedCommunityPreview(input: {
  executor: DbExecutor
  preview: CommunityPreview
  locale?: string | null
}): Promise<CommunityPreview> {
  const localizedText = await buildCommunityTextLocalizationInternal({
    executor: input.executor,
    communityId: input.preview.community_id,
    locale: input.locale,
    fields: collectPreviewFields(input.preview),
  })

  return {
    ...input.preview,
    localized_text: localizedText,
  }
}

export async function enqueueCommunityTextTranslationOnReadIfNeeded(input: {
  executor: DbExecutor
  communityId: string
  localization: CommunityTextLocalization | null | undefined
}): Promise<void> {
  const localization = input.localization
  if (!localization || !localization.items.some((item) => item.translation_state === "pending")) {
    return
  }

  await enqueueCommunityJob({
    client: input.executor,
    communityId: input.communityId,
    jobType: "community_text_translation_materialize",
    subjectType: "community_text_translation",
    subjectId: `${input.communityId}:${localization.resolved_locale}`,
    payloadJson: JSON.stringify({
      locale: localization.resolved_locale,
    } satisfies CommunityTextMaterializePayload),
    createdAt: nowIso(),
  })
}

export function parseCommunityTextMaterializePayload(raw: string | null): CommunityTextMaterializePayload | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" ? parsed as CommunityTextMaterializePayload : null
  } catch {
    return null
  }
}

export async function materializeCommunityTextTranslations(input: {
  executor: DbExecutor
  env: Env
  community: Community
  locale?: string | null
}): Promise<string> {
  const resolvedLocale = normalizeContentLocale(input.locale) ?? DEFAULT_CONTENT_LOCALE
  const fields = collectCommunityFields(input.community)
  if (fields.length === 0) {
    return `skipped:no_content:${resolvedLocale}`
  }

  const metadata = await ensureCommunityLocalizationMeta({
    executor: input.executor,
    communityId: input.community.community_id,
    fields,
  })

  let translatedCount = 0
  for (const field of fields) {
    const meta = metadata.get(field.field_key)
    if (!meta) {
      continue
    }

    if (sameLanguageLocale(meta.source_language, resolvedLocale)) {
      await upsertContentTranslation({
        executor: input.executor,
        contentType: "community_text",
        contentId: input.community.community_id,
        fieldKey: field.field_key,
        locale: resolvedLocale,
        sourceHash: meta.source_hash,
        sourceLanguage: meta.source_language ?? resolvedLocale,
        outcome: "same_language",
        now: nowIso(),
      })
      continue
    }

    if (meta.translation_policy === "none" || meta.translation_policy === "human_only") {
      continue
    }

    const existing = await getContentTranslation({
      executor: input.executor,
      contentType: "community_text",
      contentId: input.community.community_id,
      fieldKey: field.field_key,
      locale: resolvedLocale,
      sourceHash: meta.source_hash,
    })
    if (existing && (existing.outcome === "same_language" || hasTranslatedBody(existing))) {
      translatedCount += existing.outcome === "translated" ? 1 : 0
      continue
    }

    const translation = await requestContentTranslation({
      env: input.env,
      sourceLanguage: meta.source_language ?? null,
      targetLocale: resolvedLocale,
      sourceText: {
        body: field.source_text,
      },
    })

    await upsertContentTranslation({
      executor: input.executor,
      contentType: "community_text",
      contentId: input.community.community_id,
      fieldKey: field.field_key,
      locale: resolvedLocale,
      sourceHash: meta.source_hash,
      sourceLanguage: translation.sourceLanguage,
      outcome: translation.outcome,
      translatedBody: translation.translatedBody,
      provider: translation.provider,
      providerModel: translation.model,
      providerResultJson: translation.providerResult ? JSON.stringify(translation.providerResult) : null,
      now: nowIso(),
    })

    if (translation.outcome === "translated") {
      translatedCount += 1
    }
  }

  return `${resolvedLocale}:translated:${translatedCount}`
}
