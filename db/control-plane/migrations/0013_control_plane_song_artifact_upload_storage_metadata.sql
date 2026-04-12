ALTER TABLE song_artifact_uploads ADD COLUMN storage_provider TEXT;
ALTER TABLE song_artifact_uploads ADD COLUMN storage_bucket TEXT;
ALTER TABLE song_artifact_uploads ADD COLUMN storage_object_key TEXT;
ALTER TABLE song_artifact_uploads ADD COLUMN storage_endpoint TEXT;
ALTER TABLE song_artifact_uploads ADD COLUMN gateway_url TEXT;
