# community-protocol-issuer

Background issuer for community protocol handle issuance.

The issuer reads pending protocol issuance work from the API/control-plane data layer, requests proof artifacts, calls the protocol service, and records the resulting issuance state. It is designed to run as a one-shot worker process rather than as a public HTTP service.

## Entry Points

- `src/main.ts` runs one issuer pass and prints a JSON success or error result.
- `src/index.ts` exports the package internals used by tests and other local tooling.

## Development

```bash
bun install
bun run check
bun run test
```

Run one local issuer pass with the required environment configured:

```bash
bun run run:once
```

## Runtime Shape

The core workflow lives in `src/lib/issuer-workflow.ts` and is orchestrated by `src/lib/runtime.ts`.

Important modules:

- `config.ts` validates runtime environment.
- `protocol-issuance-db.ts` reads and writes issuance state.
- `proof-artifact-store.ts` handles proof artifacts.
- `runpod-proof-client.ts` calls the prover service.
- `subsd-client.ts` calls the protocol issuance service.

## Tests

Tests are colocated with the implementation under `src/lib/*.test.ts` and run with `bun:test`.

```bash
bun run test
```

The package is included in API CI.
