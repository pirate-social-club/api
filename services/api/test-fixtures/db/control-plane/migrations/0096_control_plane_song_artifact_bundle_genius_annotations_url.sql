ALTER TABLE song_artifact_bundles ADD COLUMN IF NOT EXISTS genius_annotations_url TEXT;

UPDATE song_artifact_bundles
SET genius_annotations_url = NULL
WHERE genius_annotations_url IS NULL;
