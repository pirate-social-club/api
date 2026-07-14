# Pirate API

Backend services for Pirate.

## Services

- `services/api`
- `services/agent-connector`
- `services/cli`
- `services/contracts`
- `services/efp-shared`
- `services/shared`
- `services/zkpassport-verifier-container`

## Default Checks

```bash
rtk bun run check:hygiene  # stale markers and route coverage map sanity
rtk bun run check:cli      # CLI typecheck after services/cli dependencies are installed
rtk bun run check          # broad repo chain; use only when needed
```

Most TypeScript service checks use the TypeScript 7 native preview compiler (`tsgo`). Prefer service-local `rtk bun run check` for focused work on weak machines; the repo-level `rtk bun run check` still chains hygiene, shared, contracts, agent connector, issuer, ZKPassport container, and API checks.

For route work, run the focused `rtk bun test path/to/test.ts` file for the touched route group after the smallest relevant service check.
