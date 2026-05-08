WITH ranked_wallet_attachments AS (
    SELECT
        wallet_attachment_id,
        ROW_NUMBER() OVER (
            PARTITION BY chain_namespace, wallet_address_normalized
            ORDER BY is_primary DESC, attached_at ASC, created_at ASC, wallet_attachment_id ASC
        ) AS owner_rank
    FROM wallet_attachments
    WHERE status = 'active'
)
UPDATE wallet_attachments
SET status = 'detached',
    is_primary = 0,
    detached_at = COALESCE(detached_at, CURRENT_TIMESTAMP),
    updated_at = CURRENT_TIMESTAMP
WHERE wallet_attachment_id IN (
    SELECT wallet_attachment_id
    FROM ranked_wallet_attachments
    WHERE owner_rank > 1
);

UPDATE users
SET primary_wallet_attachment_id = (
        SELECT wallet_attachment_id
        FROM wallet_attachments
        WHERE wallet_attachments.user_id = users.user_id
          AND wallet_attachments.status = 'active'
        ORDER BY wallet_attachments.is_primary DESC,
                 wallet_attachments.attached_at ASC,
                 wallet_attachments.created_at ASC,
                 wallet_attachments.wallet_attachment_id ASC
        LIMIT 1
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE primary_wallet_attachment_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM wallet_attachments
      WHERE wallet_attachments.wallet_attachment_id = users.primary_wallet_attachment_id
        AND wallet_attachments.status = 'active'
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_attachments_active_address
    ON wallet_attachments(chain_namespace, wallet_address_normalized)
    WHERE status = 'active';
