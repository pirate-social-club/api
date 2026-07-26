CREATE INDEX idx_analytics_outbox_status_sent_at
    ON analytics_outbox(status, sent_at);
