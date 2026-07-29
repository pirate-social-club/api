-- Versioned choreography references and dark-pilot grading coordination.
-- Posts remain community-shard resources, so post identifiers are deliberately
-- bound by the API rather than by impossible cross-database foreign keys.

CREATE TABLE dance_choreographies (
    dance_choreography_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL REFERENCES communities(community_id),
    host_post_id TEXT NOT NULL,
    referenced_song_post_id TEXT NOT NULL,
    song_artifact_bundle_id TEXT NOT NULL
        REFERENCES song_artifact_bundles(song_artifact_bundle_id),
    creator_user_id TEXT NOT NULL REFERENCES users(user_id),
    official INTEGER NOT NULL DEFAULT 0 CHECK (official IN (0, 1)),
    status TEXT NOT NULL CHECK (
        status IN ('draft', 'processing', 'ready', 'disabled', 'failed')
    ),
    active_revision_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (community_id, host_post_id),
    CONSTRAINT dance_choreographies_ready_has_active_revision_check CHECK (
        (status <> 'ready' OR active_revision_id IS NOT NULL) IS TRUE
    )
);

CREATE INDEX idx_dance_choreographies_song_ready
    ON dance_choreographies(community_id, referenced_song_post_id, created_at DESC)
    WHERE status = 'ready';

CREATE TABLE dance_choreography_revisions (
    dance_choreography_revision_id TEXT PRIMARY KEY,
    dance_choreography_id TEXT NOT NULL
        REFERENCES dance_choreographies(dance_choreography_id),
    revision_number INTEGER NOT NULL CHECK (revision_number > 0),
    reference_storage_ref TEXT NOT NULL,
    reference_content_sha256 TEXT NOT NULL CHECK (
        reference_content_sha256 ~ '^[0-9a-f]{64}$'
    ),
    reference_mime_type TEXT NOT NULL CHECK (
        reference_mime_type IN ('video/mp4', 'video/webm', 'video/quicktime')
    ),
    reference_size_bytes BIGINT NOT NULL CHECK (
        reference_size_bytes > 0 AND reference_size_bytes <= 67108864
    ),
    reference_duration_ms INTEGER CHECK (
        reference_duration_ms IS NULL
        OR reference_duration_ms BETWEEN 1000 AND 90000
    ),
    reference_width INTEGER CHECK (reference_width IS NULL OR reference_width > 0),
    reference_height INTEGER CHECK (reference_height IS NULL OR reference_height > 0),
    reference_fps_millihertz INTEGER CHECK (
        reference_fps_millihertz IS NULL OR reference_fps_millihertz > 0
    ),
    reference_feature_ref TEXT,
    reference_feature_sha256 TEXT CHECK (
        reference_feature_sha256 IS NULL
        OR reference_feature_sha256 ~ '^[0-9a-f]{64}$'
    ),
    reference_feature_size_bytes BIGINT CHECK (
        reference_feature_size_bytes IS NULL OR reference_feature_size_bytes > 0
    ),
    pose_model_version TEXT,
    pose_model_sha256 TEXT CHECK (
        pose_model_sha256 IS NULL OR pose_model_sha256 ~ '^[0-9a-f]{64}$'
    ),
    pose_runtime_version TEXT,
    feature_schema_version TEXT,
    scorer_version TEXT,
    artifact_version TEXT,
    mirror_policy TEXT NOT NULL DEFAULT 'allowed'
        CHECK (mirror_policy IN ('strict', 'allowed')),
    status TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'failed', 'retired')),
    failure_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ready_at TIMESTAMPTZ,
    retired_at TIMESTAMPTZ,
    UNIQUE (dance_choreography_id, revision_number),
    UNIQUE (dance_choreography_id, reference_content_sha256),
    UNIQUE (dance_choreography_id, dance_choreography_revision_id),
    CONSTRAINT dance_choreography_revision_status_fields_check CHECK (
      (
        (status = 'processing' AND failure_code IS NULL AND ready_at IS NULL)
        OR (
            status = 'ready'
            AND failure_code IS NULL
            AND ready_at IS NOT NULL
            AND reference_duration_ms IS NOT NULL
            AND reference_width IS NOT NULL
            AND reference_height IS NOT NULL
            AND reference_fps_millihertz IS NOT NULL
            AND reference_feature_ref IS NOT NULL
            AND reference_feature_sha256 IS NOT NULL
            AND reference_feature_size_bytes IS NOT NULL
            AND pose_model_version IS NOT NULL
            AND pose_model_sha256 IS NOT NULL
            AND pose_runtime_version IS NOT NULL
            AND feature_schema_version IS NOT NULL
            AND scorer_version IS NOT NULL
            AND artifact_version IS NOT NULL
        )
        OR (status = 'failed' AND failure_code IS NOT NULL)
          OR (status = 'retired' AND retired_at IS NOT NULL)
      ) IS TRUE
    )
);

ALTER TABLE dance_choreographies
    ADD CONSTRAINT dance_choreographies_active_revision_fkey
    FOREIGN KEY (dance_choreography_id, active_revision_id)
    REFERENCES dance_choreography_revisions(
        dance_choreography_id,
        dance_choreography_revision_id
    )
    DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX idx_dance_choreography_revisions_processing
    ON dance_choreography_revisions(status, created_at)
    WHERE status = 'processing';

CREATE OR REPLACE FUNCTION enforce_ready_dance_revision_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.status IN ('ready', 'retired') AND (
        NEW.dance_choreography_id,
        NEW.revision_number,
        NEW.reference_storage_ref,
        NEW.reference_content_sha256,
        NEW.reference_mime_type,
        NEW.reference_size_bytes,
        NEW.reference_duration_ms,
        NEW.reference_width,
        NEW.reference_height,
        NEW.reference_fps_millihertz,
        NEW.reference_feature_ref,
        NEW.reference_feature_sha256,
        NEW.reference_feature_size_bytes,
        NEW.pose_model_version,
        NEW.pose_model_sha256,
        NEW.pose_runtime_version,
        NEW.feature_schema_version,
        NEW.scorer_version,
        NEW.artifact_version,
        NEW.mirror_policy,
        NEW.created_at,
        NEW.ready_at
    ) IS DISTINCT FROM (
        OLD.dance_choreography_id,
        OLD.revision_number,
        OLD.reference_storage_ref,
        OLD.reference_content_sha256,
        OLD.reference_mime_type,
        OLD.reference_size_bytes,
        OLD.reference_duration_ms,
        OLD.reference_width,
        OLD.reference_height,
        OLD.reference_fps_millihertz,
        OLD.reference_feature_ref,
        OLD.reference_feature_sha256,
        OLD.reference_feature_size_bytes,
        OLD.pose_model_version,
        OLD.pose_model_sha256,
        OLD.pose_runtime_version,
        OLD.feature_schema_version,
        OLD.scorer_version,
        OLD.artifact_version,
        OLD.mirror_policy,
        OLD.created_at,
        OLD.ready_at
    ) THEN
        RAISE EXCEPTION 'ready dance choreography revision fields are immutable';
    END IF;
    IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
        RAISE EXCEPTION 'retired dance choreography revisions cannot be reactivated';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER dance_choreography_revisions_immutable
BEFORE UPDATE ON dance_choreography_revisions
FOR EACH ROW
EXECUTE FUNCTION enforce_ready_dance_revision_immutability();
