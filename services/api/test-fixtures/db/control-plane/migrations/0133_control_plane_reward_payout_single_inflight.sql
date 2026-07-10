-- A user may have at most one reward transfer in flight. The application user-row
-- lock serializes normal reservations; this partial unique index is the database
-- backstop for cross-tab, retry, and future-writer races.

CREATE UNIQUE INDEX reward_payout_effects_one_submitted_per_user
    ON reward_payout_effects (user_id)
    WHERE status = 'submitted';
