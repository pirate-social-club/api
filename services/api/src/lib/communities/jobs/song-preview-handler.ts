import { generateSongPreviewForBundle } from "../../song-artifacts/song-artifact-preview-service"
import type { CommunityJobHandlerInput } from "./handler-types"
import { parseJobPayload } from "./payload"

type SongPreviewGeneratePayload = {
  song_artifact_bundle?: string | null
  primary_audio_content_hash?: string | null
  preview_window?: {
    start_ms: number
    duration_ms: number
  } | null
}

export async function runSongPreviewGenerate(input: CommunityJobHandlerInput): Promise<string | null> {
  const payload = parseJobPayload<SongPreviewGeneratePayload>(input.job.payload_json)
  return await generateSongPreviewForBundle({
    env: input.env,
    communityId: input.job.community_id,
    songArtifactBundleId: payload?.song_artifact_bundle ?? input.job.subject_id,
    expectedPrimaryAudioContentHash: payload?.primary_audio_content_hash ?? null,
  })
}
