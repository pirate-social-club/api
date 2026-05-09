# Pirate API

Backend services for Pirate.

## Services

- `services/api`
- `services/cli`
- `services/contracts`
- `services/shared`
- `services/community-protocol-issuer`
- `services/community-provision-operator`
- `services/community-protocol-prover-runpod`

## Default Checks

```bash
bun run check          # hygiene, contracts typecheck, API typecheck
bun run check:cli      # CLI typecheck after services/cli dependencies are installed
bun run check:hygiene  # stale markers and route coverage map sanity
```

Type-check scripts use the TypeScript 7 native preview compiler (`tsgo`). Prefer service-local `bun run check` for focused work on weak machines; the repo-level check still chains multiple checks.

For route work, run the focused `bun test` file for the touched route group after `bun run check`.
