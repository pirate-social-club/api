-- Repair grants for the royalty-allocation projection table created by 0118.
-- The API writes verified community-shard allocation rows into this control-plane
-- projection; read roles use it for global claim/discovery surfaces.

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE story_royalty_allocation_projections
TO control_plane_api_rw;

GRANT SELECT
ON TABLE story_royalty_allocation_projections
TO control_plane_api_ro, control_plane_ops_ro;
