import { internalError } from "../../errors"
import {
  runLinkSummaryMaterialize,
  runLinkSummaryTranslationMaterialize,
} from "./link-summary-handlers"
import {
  runCommentBodyMirror,
  runThreadSnapshotPublish,
} from "./swarm-publish-handlers"
import {
  runCommentProjectionSync,
  runPostProjectionSync,
} from "./projection-sync-handlers"
import {
  runCommentTranslationMaterialize,
  runCommunityTextTranslationMaterialize,
  runPostLabelMaterialize,
  runPostTranslationMaterialize,
} from "./content-materialization-handlers"
import { runEmbedHydrate } from "./embed-hydration-handler"
import { runLiveRoomViewerSessionsPrune } from "./live-room-maintenance-handler"
import { runSongPreviewGenerate } from "./song-preview-handler"
import type { CommunityJobHandlerInput } from "./handler-types"

export async function runCommunityJob(input: CommunityJobHandlerInput): Promise<string | null> {
  switch (input.job.job_type) {
    case "comment_projection_sync":
      return runCommentProjectionSync(input)
    case "post_projection_sync":
      return runPostProjectionSync(input)
    case "comment_body_mirror":
      return runCommentBodyMirror(input)
    case "thread_snapshot_publish":
      return runThreadSnapshotPublish(input)
    case "embed_hydrate":
    case "link_preview_fetch":
      return runEmbedHydrate(input)
    case "post_label_materialize":
      return runPostLabelMaterialize(input)
    case "post_translation_materialize":
      return runPostTranslationMaterialize(input)
    case "link_summary_materialize":
      return runLinkSummaryMaterialize(input)
    case "link_summary_translation_materialize":
      return runLinkSummaryTranslationMaterialize(input)
    case "comment_translation_materialize":
      return runCommentTranslationMaterialize(input)
    case "community_text_translation_materialize":
      return runCommunityTextTranslationMaterialize(input)
    case "song_preview_generate":
      return runSongPreviewGenerate(input)
    case "live_room_viewer_sessions_prune":
      return runLiveRoomViewerSessionsPrune(input)
    default:
      throw internalError(`Unsupported community job type: ${input.job.job_type}`)
  }
}
