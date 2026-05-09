# API Shared

Small runtime-safe primitives shared by API repo services.

Keep this package limited to platform-neutral helpers that are stable across Workers, Bun, and Node-style scripts. Do not add service clients, Sentry setup, database logic, or environment-specific configuration here.

Current exports:

- `trim`
- `requireText`
- `nowIso`
- `makeId`

```bash
rtk bun run check
```
