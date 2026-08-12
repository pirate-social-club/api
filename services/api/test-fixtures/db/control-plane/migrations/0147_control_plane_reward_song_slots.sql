-- A funding quote reserves one song post only for the quote's bounded lifetime.
-- Live campaigns remain protected by reward_campaigns_one_live_per_song_post;
-- this table closes the pre-funding race without making abandoned quotes a
-- permanent lock or depending on a scheduled sweep for liveness.
CREATE TABLE reward_song_slots (
    community_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    holder_campaign_id TEXT NOT NULL,
    reserved_until TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (community_id, post_id),
    UNIQUE (holder_campaign_id),
    FOREIGN KEY (community_id) REFERENCES communities(community_id),
    FOREIGN KEY (holder_campaign_id) REFERENCES reward_campaigns(reward_campaign_id)
);

CREATE INDEX reward_song_slots_expiry_idx
    ON reward_song_slots (reserved_until, community_id, post_id);
