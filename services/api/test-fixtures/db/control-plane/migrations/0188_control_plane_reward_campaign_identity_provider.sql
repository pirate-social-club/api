-- Pin the unique-human provider to the permanent song pool. Existing pools
-- inherit the currently-supported production provider; historical credits keep
-- their already-snapshotted reward_identity_id and are not rewritten.

ALTER TABLE reward_campaigns
    ADD COLUMN reward_identity_provider TEXT NOT NULL DEFAULT 'self';

ALTER TABLE reward_campaigns
    ADD CONSTRAINT reward_campaign_identity_provider_check
        CHECK (reward_identity_provider IN ('self', 'zkpassport', 'very'));

-- Provider selection is a money-bearing campaign term. Keep this database
-- guard separate from older trigger history so migrations remain reproducible.
CREATE FUNCTION reject_reward_campaign_identity_provider_changes()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.reward_identity_provider IS DISTINCT FROM OLD.reward_identity_provider
    THEN
        RAISE EXCEPTION 'reward campaign identity provider is immutable'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER reward_campaigns_identity_provider_immutable
BEFORE UPDATE ON reward_campaigns
FOR EACH ROW
EXECUTE FUNCTION reject_reward_campaign_identity_provider_changes();
