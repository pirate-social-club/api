-- Allow independent Study and Karaoke claims while preserving the historical
-- Either campaign boundary. Legacy Either claims remain globally exclusive for
-- a song/day; new objective campaigns are exclusive only within their slot.

DROP INDEX IF EXISTS reward_song_period_claims_song_identity_period_unique;

ALTER TABLE reward_song_period_claims RENAME TO reward_song_period_claims_legacy;

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
    objective TEXT NOT NULL CHECK (objective IN ('study', 'karaoke', 'either')),
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (reward_campaign_reservation_id)
        REFERENCES reward_campaign_reservations(reward_campaign_reservation_id)
        DEFERRABLE INITIALLY DEFERRED,
    UNIQUE (community_id, post_id, reward_identity_id, reward_period_key, reward_kind, objective)
);

INSERT INTO reward_song_period_claims (
    reward_campaign_reservation_id, community_id, post_id,
    song_artifact_bundle_id, reward_identity_id, reward_period_key,
    reward_kind, objective, claimed_at
)
SELECT
    claim.reward_campaign_reservation_id,
    claim.community_id,
    claim.post_id,
    claim.song_artifact_bundle_id,
    claim.reward_identity_id,
    claim.reward_period_key,
    claim.reward_kind,
    campaign.eligible_activity,
    claim.claimed_at
FROM reward_song_period_claims_legacy AS claim
JOIN reward_campaign_reservations AS reservation
  ON reservation.reward_campaign_reservation_id = claim.reward_campaign_reservation_id
JOIN reward_campaigns AS campaign
  ON campaign.reward_campaign_id = reservation.reward_campaign_id;

DROP TABLE reward_song_period_claims_legacy;
