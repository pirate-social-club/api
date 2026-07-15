-- Enforce one campaign practice reward per unique human, song post, and UTC day
-- across campaign boundaries. The campaign-scoped reservation key alone permits
-- a second payment when one campaign ends and another starts on the same song.
CREATE TABLE reward_song_period_claims (
    reward_campaign_reservation_id TEXT PRIMARY KEY,
    community_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    song_artifact_bundle_id TEXT NOT NULL,
    reward_identity_id TEXT NOT NULL,
    reward_period_key DATE NOT NULL,
    reward_kind TEXT NOT NULL CHECK (reward_kind IN (
        'campaign_practice_day',
        'campaign_milestone_7',
        'campaign_milestone_30'
    )),
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (reward_campaign_reservation_id)
        REFERENCES reward_campaign_reservations(reward_campaign_reservation_id)
        DEFERRABLE INITIALLY DEFERRED,
    UNIQUE (community_id, post_id, reward_identity_id, reward_period_key, reward_kind)
);

-- Rewards are dark at rollout, but backfill defensively. If historical data already
-- contains two paid/reserved claims for one human/song/day, the unique constraint
-- makes the migration fail closed for operator review instead of choosing a winner.
INSERT INTO reward_song_period_claims (
    reward_campaign_reservation_id, community_id, post_id,
    song_artifact_bundle_id, reward_identity_id, reward_period_key,
    reward_kind, claimed_at
)
SELECT
    r.reward_campaign_reservation_id, c.community_id, c.post_id,
    c.song_artifact_bundle_id, r.reward_identity_id, r.reward_period_key,
    r.reward_kind, r.created_at
FROM reward_campaign_reservations r
JOIN reward_campaigns c ON c.reward_campaign_id = r.reward_campaign_id
WHERE r.status IN ('reserved', 'credited');
