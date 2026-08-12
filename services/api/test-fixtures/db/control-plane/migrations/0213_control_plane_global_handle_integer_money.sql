-- Global-handle APIs already expose integer cents. Store the same unit in the
-- control plane so paid claims never cross a floating-point USD boundary.

ALTER TABLE global_handles
    ADD COLUMN price_paid_cents INTEGER CHECK (
        price_paid_cents IS NULL OR price_paid_cents >= 0
    );

UPDATE global_handles
SET price_paid_cents = CAST(ROUND(price_paid_usd * 100) AS INTEGER)
WHERE price_paid_usd IS NOT NULL;

ALTER TABLE global_handles
    DROP COLUMN price_paid_usd;
