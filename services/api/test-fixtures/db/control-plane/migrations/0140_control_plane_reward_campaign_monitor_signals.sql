-- Monitor liveness and finality-coverage completeness are independent signals.
-- Existing rows were only written after a complete scan, so their successful
-- timestamp is also truthful opening evidence for both attempted timestamps.

ALTER TABLE reward_campaign_monitor_state
    ADD COLUMN first_attempted_scan_at TIMESTAMPTZ;

ALTER TABLE reward_campaign_monitor_state
    ADD COLUMN last_attempted_scan_at TIMESTAMPTZ;

UPDATE reward_campaign_monitor_state
SET first_attempted_scan_at = last_successful_scan_at,
    last_attempted_scan_at = last_successful_scan_at;

ALTER TABLE reward_campaign_monitor_state
    ALTER COLUMN first_attempted_scan_at SET NOT NULL;

ALTER TABLE reward_campaign_monitor_state
    ALTER COLUMN last_attempted_scan_at SET NOT NULL;

-- A cold-start monitor may complete attempts before it ever achieves full
-- finality coverage. NULL represents that state without inventing a success.
ALTER TABLE reward_campaign_monitor_state
    ALTER COLUMN last_successful_scan_at DROP NOT NULL;
