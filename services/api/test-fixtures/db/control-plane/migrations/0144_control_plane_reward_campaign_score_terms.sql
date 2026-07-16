-- Campaign-owned Karaoke score threshold for the first funded pilot.
--
-- Existing campaigns retain the platform's original 70% qualification floor.
-- New V1 campaigns may strengthen, but not lower, that floor because attempts
-- below it do not yet emit reward qualification events.

ALTER TABLE reward_campaigns
    ADD COLUMN min_score_bps INTEGER NOT NULL DEFAULT 7000
        CHECK (min_score_bps >= 7000 AND min_score_bps <= 10000);

CREATE FUNCTION reject_reward_campaign_score_term_changes()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.min_score_bps IS DISTINCT FROM OLD.min_score_bps THEN
        RAISE EXCEPTION 'reward campaign score terms are immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reward_campaign_score_terms_immutable
BEFORE UPDATE ON reward_campaigns
FOR EACH ROW
EXECUTE FUNCTION reject_reward_campaign_score_term_changes();
