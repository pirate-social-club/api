import type { Env } from "../../env"

type StudyVoiceAdmissionEnv = Pick<
  Env,
  "TELEGRAM_STUDY_VOICE_ENABLED" | "TELEGRAM_STUDY_VOICE_COMMUNITY_IDS"
>

export function isTelegramStudyVoiceEnabled(
  env: StudyVoiceAdmissionEnv,
  communityId: string,
): boolean {
  if (env.TELEGRAM_STUDY_VOICE_ENABLED !== "true") return false
  const candidate = communityId.trim()
  if (!candidate) return false
  return String(env.TELEGRAM_STUDY_VOICE_COMMUNITY_IDS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .includes(candidate)
}
