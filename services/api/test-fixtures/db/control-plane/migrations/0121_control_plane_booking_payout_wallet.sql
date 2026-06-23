-- Host payout destination wallet for paid bookings.
-- Nullable at the schema level (existing profiles predate it), but REQUIRED before a profile can
-- publish and REQUIRED at confirm -- enforced in application logic. Snapshotted onto each booking
-- at confirm so settlement never depends on whatever the host primary wallet is later.
ALTER TABLE booking_profiles ADD COLUMN payout_wallet_address TEXT;
