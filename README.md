# Pirate API

Backend services for Pirate.

## Services

- `services/api`
- `services/cli`
- `services/contracts`

## Default Checks

```bash
bun run check          # hygiene, contracts typecheck, API typecheck
bun run check:cli      # CLI typecheck after services/cli dependencies are installed
bun run check:hygiene  # stale markers and route coverage map sanity
```

For route work, run the focused `bun test` file for the touched route group after `bun run check`.
