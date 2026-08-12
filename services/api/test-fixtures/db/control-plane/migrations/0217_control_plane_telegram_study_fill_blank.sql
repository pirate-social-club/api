ALTER TABLE telegram_chat_study_sessions
    DROP CONSTRAINT IF EXISTS telegram_chat_study_sessions_action_kind_check;

-- migration-safety: existing-table-check-reviewed: every existing action_kind remains valid; this only adds answer_fill_blank.
ALTER TABLE telegram_chat_study_sessions
    ADD CONSTRAINT telegram_chat_study_sessions_action_kind_check CHECK (
        action_kind IN ('select_song', 'answer_choice', 'answer_fill_blank', 'await_voice', 'none')
    );
