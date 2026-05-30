ALTER TABLE telegram_assistant_events
    DROP CONSTRAINT IF EXISTS telegram_assistant_events_trigger_type_check;

ALTER TABLE telegram_assistant_events
    ADD CONSTRAINT telegram_assistant_events_trigger_type_check
    CHECK (
        trigger_type IN (
            'ask_command',
            'ask_command_mention',
            'reply_to_bot',
            'starter_events',
            'starter_trending'
        )
    );
