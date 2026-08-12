-- The per-minute EFP scanner replays a 128-block reorg window and filters raw
-- event tables by (chain_id, block_number BETWEEN ...). On efp_list_ops the
-- existing idx_efp_list_ops_slot_order sits contract_address and slot between
-- the equality key and block_number, and the primary-list/storage-location
-- tables have no chain-ordered index at all, so every replay range scan and
-- range delete walked a full chain partition. Add dedicated chain/block
-- indexes for the replay read and delete paths.
--
-- Production note: on a hot database, pre-create these indexes with
-- CREATE INDEX CONCURRENTLY using the same names before applying this
-- migration; IF NOT EXISTS then records the migration without a fresh build.
-- INCLUDE columns are deliberately avoided to keep the mirrored SQLite
-- fixture tree compatible.

CREATE INDEX IF NOT EXISTS idx_efp_list_ops_chain_block
    ON efp_list_ops(chain_id, block_number);

CREATE INDEX IF NOT EXISTS idx_efp_primary_list_events_chain_block
    ON efp_primary_list_events(chain_id, block_number);

CREATE INDEX IF NOT EXISTS idx_efp_list_storage_location_events_chain_block
    ON efp_list_storage_location_events(chain_id, block_number);
