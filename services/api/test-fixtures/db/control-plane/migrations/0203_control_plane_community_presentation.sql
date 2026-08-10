ALTER TABLE communities
    ADD COLUMN default_surface TEXT NOT NULL DEFAULT 'threads';

ALTER TABLE communities
    ADD CONSTRAINT communities_default_surface_check CHECK (
        default_surface IN ('threads', 'videos')
    );

ALTER TABLE communities
    ADD COLUMN branding_json JSONB NOT NULL DEFAULT '{}'::jsonb;
