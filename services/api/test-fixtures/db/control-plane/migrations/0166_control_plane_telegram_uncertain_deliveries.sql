-- Telegram channel deliveries: make an ambiguous send an explicit state.
--
-- The Bot API has no idempotency key and no way to read back arbitrary channel
-- history, so a send whose response was lost can never be reconciled
-- automatically. 0162 modelled every pre-delivery row as 'pending', which
-- forced a choice between retrying (duplicating the channel post once per
-- attempt) and stranding rows that were never actually sent.
--
-- Two states replace that ambiguity:
--   'sending'   durable in-flight marker written BEFORE the Telegram call. A
--               crash after this point may or may not have reached Telegram.
--   'uncertain' known-ambiguous, excluded from all automatic retries and
--               awaiting an explicit operator resolution.
--
-- 'pending' is retained: it is the column default, it describes rows reserved
-- but not yet handed to Telegram, and existing rows still carry it.

ALTER TABLE telegram_post_deliveries
    DROP CONSTRAINT IF EXISTS telegram_post_deliveries_status_check;

ALTER TABLE telegram_post_deliveries
    DROP CONSTRAINT IF EXISTS telegram_post_deliveries_status_check1;

ALTER TABLE telegram_post_deliveries
    ADD CONSTRAINT telegram_post_deliveries_status_check
    CHECK (status IN ('pending', 'sending', 'delivered', 'failed', 'uncertain', 'deleted'));

-- Operator resolution audit. Null on every row that has never been resolved.
ALTER TABLE telegram_post_deliveries
    ADD COLUMN IF NOT EXISTS resolved_at TEXT;

ALTER TABLE telegram_post_deliveries
    ADD COLUMN IF NOT EXISTS resolved_by_user_id TEXT;

ALTER TABLE telegram_post_deliveries
    ADD COLUMN IF NOT EXISTS resolution_action TEXT;

ALTER TABLE telegram_post_deliveries
    ADD COLUMN IF NOT EXISTS resolution_reason TEXT;

ALTER TABLE telegram_post_deliveries
    DROP CONSTRAINT IF EXISTS telegram_post_deliveries_resolution_action_check;

ALTER TABLE telegram_post_deliveries
    ADD CONSTRAINT telegram_post_deliveries_resolution_action_check
    CHECK (resolution_action IS NULL OR resolution_action IN ('marked_delivered', 'retry_authorized'));

-- A resolution is only meaningful as a complete record: action, actor and time
-- are written together or not at all. The reason stays optional.
ALTER TABLE telegram_post_deliveries
    DROP CONSTRAINT IF EXISTS telegram_post_deliveries_resolution_complete_check;

ALTER TABLE telegram_post_deliveries
    ADD CONSTRAINT telegram_post_deliveries_resolution_complete_check
    CHECK (
        (resolution_action IS NULL AND resolved_at IS NULL AND resolved_by_user_id IS NULL)
        OR (resolution_action IS NOT NULL AND resolved_at IS NOT NULL AND resolved_by_user_id IS NOT NULL)
    );

ALTER TABLE telegram_post_deliveries
    DROP CONSTRAINT IF EXISTS telegram_post_deliveries_resolved_by_user_id_fkey;

ALTER TABLE telegram_post_deliveries
    ADD CONSTRAINT telegram_post_deliveries_resolved_by_user_id_fkey
    FOREIGN KEY (resolved_by_user_id) REFERENCES users(user_id);

-- Ops surfacing: stranded deliveries are listed and counted by community or by
-- destination, filtered by age. Partial indexes keep these off the hot path.
CREATE INDEX IF NOT EXISTS idx_telegram_post_deliveries_uncertain_community
    ON telegram_post_deliveries(community_id, updated_at)
    WHERE status = 'uncertain';

CREATE INDEX IF NOT EXISTS idx_telegram_post_deliveries_uncertain_destination
    ON telegram_post_deliveries(telegram_channel_destination_id, updated_at)
    WHERE status = 'uncertain';

-- In-flight rows are the recovery input: a 'sending' row older than the job
-- timeout is promoted to 'uncertain' rather than retried.
CREATE INDEX IF NOT EXISTS idx_telegram_post_deliveries_sending
    ON telegram_post_deliveries(updated_at)
    WHERE status = 'sending';
