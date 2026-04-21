ALTER TABLE song_artifact_bundles
ADD COLUMN preview_status TEXT NOT NULL DEFAULT 'completed';

ALTER TABLE song_artifact_bundles
ADD COLUMN preview_error TEXT;

UPDATE song_artifact_bundles
SET preview_status = CASE
  WHEN preview_audio_json IS NOT NULL THEN 'completed'
  WHEN preview_window_json IS NOT NULL THEN 'pending'
  WHEN CAST(json_extract(primary_audio_json, '$.duration_ms') AS INTEGER) > 0
       AND CAST(json_extract(primary_audio_json, '$.duration_ms') AS INTEGER) <= 30000 THEN 'pending'
  ELSE 'completed'
END,
preview_error = NULL;
