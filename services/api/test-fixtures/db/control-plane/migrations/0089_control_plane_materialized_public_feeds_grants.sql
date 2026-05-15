GRANT SELECT, INSERT, UPDATE, DELETE
    ON TABLE materialized_public_feeds
    TO control_plane_api_rw;

GRANT SELECT
    ON TABLE materialized_public_feeds
    TO control_plane_api_ro, control_plane_ops_ro;

