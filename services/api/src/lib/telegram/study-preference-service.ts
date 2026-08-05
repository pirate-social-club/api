import type { Env } from "../../env"
import { nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { rowValue } from "../sql-row"

export const STUDY_HELPER_LANGUAGES = ["en", "zh", "ar", "ka", "ru"] as const
export const STUDY_DELIVERY_MODES = ["audio", "text", "both"] as const

export type StudyHelperLanguage = typeof STUDY_HELPER_LANGUAGES[number]
export type StudyDeliveryMode = typeof STUDY_DELIVERY_MODES[number]
export type UserStudyPreference = {
  deliveryMode: StudyDeliveryMode
  helperLanguage: StudyHelperLanguage
}

export function isStudyHelperLanguage(value: unknown): value is StudyHelperLanguage {
  return typeof value === "string" && STUDY_HELPER_LANGUAGES.includes(value as StudyHelperLanguage)
}

export function isStudyDeliveryMode(value: unknown): value is StudyDeliveryMode {
  return typeof value === "string" && STUDY_DELIVERY_MODES.includes(value as StudyDeliveryMode)
}

export async function getUserStudyPreference(env: Env, userId: string): Promise<UserStudyPreference | null> {
  const result = await getControlPlaneClient(env).execute({
    sql: "SELECT helper_language, delivery_mode FROM user_study_preferences WHERE user_id = ?1 LIMIT 1",
    args: [userId],
  })
  const helperLanguage = rowValue(result.rows[0], "helper_language")
  const deliveryMode = rowValue(result.rows[0], "delivery_mode")
  return isStudyHelperLanguage(helperLanguage) && isStudyDeliveryMode(deliveryMode)
    ? { helperLanguage, deliveryMode }
    : null
}

export async function upsertUserStudyPreference(input: {
  deliveryMode: StudyDeliveryMode
  env: Env
  helperLanguage: StudyHelperLanguage
  userId: string
}): Promise<UserStudyPreference> {
  const now = nowIso()
  await getControlPlaneClient(input.env).execute({
    sql: `
      INSERT INTO user_study_preferences (user_id, helper_language, delivery_mode, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?4)
      ON CONFLICT(user_id) DO UPDATE SET
        helper_language = excluded.helper_language,
        delivery_mode = excluded.delivery_mode,
        updated_at = excluded.updated_at
    `,
    args: [input.userId, input.helperLanguage, input.deliveryMode, now],
  })
  return { helperLanguage: input.helperLanguage, deliveryMode: input.deliveryMode }
}
