ALTER TABLE song_artifact_bundles ADD COLUMN translation_status TEXT;
ALTER TABLE song_artifact_bundles ADD COLUMN translation_error TEXT;
ALTER TABLE song_artifact_bundles ADD COLUMN translated_lyrics_ref TEXT;
ALTER TABLE song_artifact_bundles ADD COLUMN translated_lyrics_json TEXT;

ALTER TABLE song_artifact_bundles ADD COLUMN alignment_status TEXT;
ALTER TABLE song_artifact_bundles ADD COLUMN alignment_error TEXT;
ALTER TABLE song_artifact_bundles ADD COLUMN timed_lyrics_ref TEXT;
ALTER TABLE song_artifact_bundles ADD COLUMN timed_lyrics_json TEXT;

ALTER TABLE song_artifact_bundles ADD COLUMN moderation_status TEXT;
ALTER TABLE song_artifact_bundles ADD COLUMN moderation_error TEXT;
ALTER TABLE song_artifact_bundles ADD COLUMN moderation_result_ref TEXT;
ALTER TABLE song_artifact_bundles ADD COLUMN moderation_result_json TEXT;

UPDATE song_artifact_bundles
SET translation_status = COALESCE(translation_status, 'pending'),
    alignment_status = COALESCE(alignment_status, 'pending'),
    moderation_status = COALESCE(moderation_status, 'pending');

CREATE INDEX idx_song_artifact_bundles_translation_status
    ON song_artifact_bundles(translation_status, created_at DESC);

CREATE INDEX idx_song_artifact_bundles_alignment_status
    ON song_artifact_bundles(alignment_status, created_at DESC);

CREATE INDEX idx_song_artifact_bundles_moderation_status
    ON song_artifact_bundles(moderation_status, created_at DESC);
