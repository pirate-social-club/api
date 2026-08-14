-- Give each song an independent Study and Karaoke reward slot.
--
-- Historical campaigns with eligible_activity='either' occupy both slots while
-- they remain non-terminal. New Either campaigns are rejected by the API; the
-- legacy value remains on the campaign row for auditability.

DROP INDEX IF EXISTS reward_song_pools_campaign_idx;

ALTER TABLE reward_song_pools RENAME TO reward_song_pools_legacy;

CREATE TABLE reward_song_pools (
    community_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    objective TEXT NOT NULL CHECK (objective IN ('study', 'karaoke')),
    reward_campaign_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (community_id, post_id, objective),
    UNIQUE (reward_campaign_id, objective),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (reward_campaign_id) REFERENCES reward_campaigns(reward_campaign_id)
);

INSERT INTO reward_song_pools (
    community_id, post_id, objective, reward_campaign_id, created_at, updated_at
)
SELECT
    pool.community_id,
    pool.post_id,
    campaign.eligible_activity,
    pool.reward_campaign_id,
    pool.created_at,
    pool.updated_at
FROM reward_song_pools_legacy AS pool
JOIN reward_campaigns AS campaign
  ON campaign.reward_campaign_id = pool.reward_campaign_id
WHERE campaign.eligible_activity IN ('study', 'karaoke');

INSERT INTO reward_song_pools (
    community_id, post_id, objective, reward_campaign_id, created_at, updated_at
)
SELECT
    pool.community_id,
    pool.post_id,
    objective.objective,
    pool.reward_campaign_id,
    pool.created_at,
    pool.updated_at
FROM reward_song_pools_legacy AS pool
JOIN reward_campaigns AS campaign
  ON campaign.reward_campaign_id = pool.reward_campaign_id
JOIN (
    SELECT 'study' AS objective
    UNION ALL
    SELECT 'karaoke' AS objective
) AS objective ON campaign.eligible_activity = 'either';

DROP TABLE reward_song_pools_legacy;

CREATE INDEX reward_song_pools_campaign_idx
    ON reward_song_pools (reward_campaign_id, community_id, post_id, objective);
