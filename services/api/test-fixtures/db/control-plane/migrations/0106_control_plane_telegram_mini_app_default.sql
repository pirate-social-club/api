UPDATE telegram_linked_chats
SET announcement_mode = 'off'
WHERE announcement_mode = 'manual';
