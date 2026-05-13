import type {
  CommunityDatabaseBindingRepository,
  CommunityReadRepository,
} from "../communities/db-community-repository"
import type {
  CreatePostRequest,
  Post,
  SongArtifactBundle,
  SongArtifactUpload,
} from "../../types"

export type SongArtifactCommunityRepository = CommunityReadRepository & CommunityDatabaseBindingRepository

export type ResolvedSongPostBundle = {
  bundle: SongArtifactBundle
  mediaRefs: NonNullable<Extract<CreatePostRequest, { post_type: "song" }>["media_refs"]>
  lyrics: string
  analysisState: Post["analysis_state"]
  contentSafetyState: Post["content_safety_state"]
  ageGatePolicy: Post["age_gate_policy"]
}

export type ResolvedVideoPostAsset = {
  upload: SongArtifactUpload
  previewUpload?: SongArtifactUpload | null
  mediaRefs: NonNullable<Extract<CreatePostRequest, { post_type: "video" }>["media_refs"]>
}
