export const FILEBASE_SONG_ARTIFACT_STORAGE_PROVIDER = "filebase"
export const LOCAL_DEV_SONG_ARTIFACT_STORAGE_PROVIDER = "local_dev_file_storage"

export type SongArtifactStorageProvider =
  | typeof FILEBASE_SONG_ARTIFACT_STORAGE_PROVIDER
  | typeof LOCAL_DEV_SONG_ARTIFACT_STORAGE_PROVIDER
