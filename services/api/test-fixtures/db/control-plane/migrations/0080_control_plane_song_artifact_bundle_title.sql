ALTER TABLE song_artifact_bundles ADD COLUMN title TEXT;

UPDATE song_artifact_bundles
SET title = 'Untitled track'
WHERE title IS NULL;
