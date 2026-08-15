import { conflictError } from "../../errors"
import {
  boundedLearningDeckCsvPreview,
  previewLearningDeckCsv,
  readLearningDeckCsvImport,
} from "../../learning/deck-authoring-service"
import type { CommunityJobHandlerInput } from "./handler-types"

type LearningDeckImportPayload = {
  content_blob_id?: unknown
  user_id?: unknown
}

function importPayload(job: CommunityJobHandlerInput["job"]): { contentBlobId: string; userId: string } {
  let parsed: LearningDeckImportPayload
  try {
    parsed = JSON.parse(job.payload_json ?? "{}") as LearningDeckImportPayload
  } catch {
    throw conflictError("Learning deck import job payload is invalid")
  }
  if (typeof parsed.content_blob_id !== "string" || !parsed.content_blob_id.trim()) {
    throw conflictError("Learning deck import content blob is missing")
  }
  if (typeof parsed.user_id !== "string" || !parsed.user_id.trim()) {
    throw conflictError("Learning deck import owner is missing")
  }
  return { contentBlobId: parsed.content_blob_id, userId: parsed.user_id }
}

export async function runLearningDeckImportParse(input: CommunityJobHandlerInput): Promise<string> {
  const { contentBlobId, userId } = importPayload(input.job)
  const csv = await readLearningDeckCsvImport({
    env: input.env,
    communityId: input.job.community_id,
    contentBlobId,
    userId,
  })
  const preview = boundedLearningDeckCsvPreview(previewLearningDeckCsv(csv))
  if (!input.recordCheckpoint) throw conflictError("Learning deck import checkpoint recorder is unavailable")
  await input.recordCheckpoint("learning_deck_import_preview_ready", preview)
  return contentBlobId
}
