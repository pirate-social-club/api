-- Durable receipt for the one-time AI-provider disclosure shown with a
-- study tutor answer.
--
-- Scoped to the learner and community rather than the chat study session. A
-- session is replaced whenever the learner opens the song picker, changes
-- language, opens settings, or starts a new song, so session grain makes the
-- disclosure recur constantly: one production tester accumulated eight sessions
-- in a day, two of them 32 seconds apart, and saw the disclosure again each
-- time. The community is part of the key because the disclosure names that
-- community's configured AI provider.
--
-- The version advances only for a material change to the disclosure's data-use
-- meaning. Ordinary copy edits do not re-show it. A caller claims a receipt
-- before sending, then removes that claim if delivery fails so a later answer
-- can show the disclosure rather than silently suppressing it.

CREATE TABLE telegram_tutor_disclosure_receipts (
    user_id TEXT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    community_id TEXT NOT NULL REFERENCES communities(community_id) ON DELETE CASCADE,
    disclosure_version INTEGER NOT NULL CHECK (disclosure_version > 0),
    shown_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (user_id, community_id, disclosure_version)
);
