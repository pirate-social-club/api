ALTER TABLE song_artifact_uploads
    ADD COLUMN content_hash_verified_at TIMESTAMPTZ;

-- Before direct multipart uploads existed, uploaded content always passed
-- through the API and was hashed from bytes server-side. Preserve that
-- provenance once, then require every new upload path to assert it explicitly.
UPDATE song_artifact_uploads AS upload
SET content_hash_verified_at = upload.updated_at
WHERE upload.status = 'uploaded'
  AND upload.content_hash IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM song_artifact_upload_sessions AS session
    WHERE session.community_id = upload.community_id
      AND session.song_artifact_upload_id = upload.song_artifact_upload_id
      AND session.upload_mode = 'direct_multipart'
  );
