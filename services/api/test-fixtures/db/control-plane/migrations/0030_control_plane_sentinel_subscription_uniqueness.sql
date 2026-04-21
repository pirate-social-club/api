CREATE UNIQUE INDEX idx_sentinel_subscriptions_chain_subscription_id
    ON sentinel_subscriptions(chain_subscription_id);

CREATE UNIQUE INDEX idx_sentinel_subscriptions_active_user
    ON sentinel_subscriptions(user_id)
    WHERE status = 'active';
