# API Contracts

Generated TypeScript contracts for API request/response bodies and route helpers.

## Source Of Truth

Do not edit `src/index.ts` by hand. It is generated from `core/specs/api`.

```bash
rtk bun run generate
```

## Checks

```bash
rtk bun run check
```

This typechecks the generated package and compiles a small consumer fixture that imports `@pirate/api-contracts` through the package export.

When the core specs checkout is available, also run:

```bash
rtk bun run check:fresh
```

That regenerates contracts to a temporary path and compares them with `src/index.ts`.
The scripts locate the core checkout through `PIRATE_CORE_REPO` or common sibling workspace paths such as `/home/t42/Documents/pirate-workspace/core`.

## Consumers

Current in-repo consumers are:

- `services/api`
- `services/cli`

The package exports TypeScript source directly:

```ts
import { apiRoutes, type CreatePostRequest } from "@pirate/api-contracts"
```

If API spec inputs under `core/specs/api` change, regenerate this package and commit the updated `src/index.ts`.
