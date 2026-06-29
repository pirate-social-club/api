# Telegram Bot Funnel Note

## Decision

Bare `/start` in a community-owned Telegram bot should introduce the bot as a free assistant. It should not show join state, auto-join, request access, or prompt verification. Token-bearing `/start` payloads remain action-specific:

- `tgsetup_*` continues Telegram chat setup.
- `join_*` and legacy community payloads continue the Telegram join/deep-link flow.
- Telegram group join requests continue to trigger gate-aware verification prompts when needed.

If the Telegram preview assistant is disabled or has no free daily messages configured, bare `/start` falls back to the existing join/verification presentation instead of sending users into a dead-end assistant prompt.

## Tradeoff

The free assistant is intentionally useful before verification, but anonymous preview messages spend real LLM budget. The current guardrails are:

- per-user Telegram preview cap from `telegramPreviewDailyCap`;
- community-wide hard stop for preview traffic;
- full assistant per-user daily cap for persisted member chats.

Verification prompts should appear when a user tries to post, contribute, join a gated group, or otherwise cross a gated action boundary. Routine preview answers should not carry a verify button.

## Payments

The bot does not currently implement Telegram payments. Telegram Wallet or TON crypto payments should not be used for digital unlocks inside Telegram. Telegram Stars is the compliant Telegram-native option for digital goods, but it adds margin and reconciliation complexity compared with Pirate's existing USDC/web checkout path.
