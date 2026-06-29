-- Repair: transfer ownership and grant access on the five booking tables created by 0120.
-- 0120 ran as the postgres superuser so tables were created owned by postgres.
-- The API role (control_plane_api_rw) had no access and the migrator could not repair
-- tables it did not own. This migration corrects both defects idempotently.
-- Must run as postgres (superuser); the apply-postgres-migrations script uses that role.

ALTER TABLE booking_profiles              OWNER TO control_plane_migrator;
ALTER TABLE booking_availability_rules    OWNER TO control_plane_migrator;
ALTER TABLE booking_availability_exceptions OWNER TO control_plane_migrator;
ALTER TABLE booking_price_rules           OWNER TO control_plane_migrator;
ALTER TABLE booking_host_slot_locks       OWNER TO control_plane_migrator;

GRANT SELECT, INSERT, UPDATE, DELETE
ON TABLE booking_profiles,
         booking_availability_rules,
         booking_availability_exceptions,
         booking_price_rules,
         booking_host_slot_locks
TO control_plane_api_rw;

GRANT SELECT
ON TABLE booking_profiles,
         booking_availability_rules,
         booking_availability_exceptions,
         booking_price_rules,
         booking_host_slot_locks
TO control_plane_api_ro, control_plane_ops_ro;
