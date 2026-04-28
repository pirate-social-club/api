import type { CommunityRepository } from "../communities/db-community-repository"
import type {
  CreatePostRequest,
  Post,
  SongArtifactBundle,
} from "../../types"

export type SongArtifactCommunityRepository = CommunityRepository

export type ResolvedSongPostBundle = {
  bundle: SongArtifactBundle
  mediaRefs: NonNullable<Extract<CreatePostRequest, { post_type: "song" }>["media_refs"]>
  lyrics: string
  analysisState: Post["analysis_state"]
  contentSafetyState: Post["content_safety_state"]
  ageGatePolicy: Post["age_gate_policy"]
}
