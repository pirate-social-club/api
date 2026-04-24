ALTER TABLE users
  ADD COLUMN IF NOT EXISTS onboarding_dismissed_at TIMESTAMPTZ;
