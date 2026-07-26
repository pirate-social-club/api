-- Prevent any writer from advertising an incomplete graph as current.
CREATE OR REPLACE FUNCTION enforce_efp_follow_current_chain_coverage()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM efp_follow_projection_state
        WHERE projection_key = 'effective-graph' AND status = 'current'
    ) AND EXISTS (
        SELECT 1
        FROM efp_follow_projection_expected_chains expected
        LEFT JOIN efp_indexer_cursors cursor
            ON cursor.chain_id = expected.chain_id
        LEFT JOIN efp_follow_projection_chain_watermarks watermark
            ON watermark.chain_id = expected.chain_id
        WHERE expected.enabled
          AND (
              cursor.chain_id IS NULL
              OR watermark.chain_id IS NULL
              OR watermark.applied_through_block < cursor.safe_head_block
          )
    ) THEN
        RAISE EXCEPTION
            'EFP follow projection cannot be current without complete expected-chain coverage';
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE CONSTRAINT TRIGGER efp_follow_current_chain_coverage
AFTER INSERT OR UPDATE OF status ON efp_follow_projection_state
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_efp_follow_current_chain_coverage();

CREATE CONSTRAINT TRIGGER efp_follow_current_chain_coverage_watermarks
AFTER INSERT OR UPDATE OR DELETE ON efp_follow_projection_chain_watermarks
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_efp_follow_current_chain_coverage();

CREATE CONSTRAINT TRIGGER efp_follow_current_chain_coverage_expected
AFTER INSERT OR UPDATE OR DELETE ON efp_follow_projection_expected_chains
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_efp_follow_current_chain_coverage();

CREATE CONSTRAINT TRIGGER efp_follow_current_chain_coverage_cursors
AFTER INSERT OR UPDATE OR DELETE ON efp_indexer_cursors
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_efp_follow_current_chain_coverage();
