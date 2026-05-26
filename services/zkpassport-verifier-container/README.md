# ZKPassport Verifier Container

Cloudflare Container wrapper for the ZKPassport proof verifier.

The main API Worker cannot run `@zkpassport/sdk.verify()` directly because the
Barretenberg WASM verifier requires a runtime that allows dynamic WASM
compilation. This service keeps the public API as a Worker, but forwards
authenticated `/verify` calls into a Cloudflare Container running the Bun
verifier from `services/api/scripts/zkpassport-verifier-service.ts`.

## Request Path

```text
pirate-api Worker
  -> HTTPS fetch to this Worker /verify
  -> container-enabled Durable Object
  -> Bun verifier container /verify
  -> @zkpassport/sdk.verify()
```

The Worker and container both enforce the same
`ZKPASSPORT_VERIFIER_SHARED_SECRET` bearer token. The Worker rejects unauthenticated
or oversized requests before waking a container.

## Configuration

The Wrangler config reuses the already-tested Dockerfile:

```jsonc
{
  "image": "../api/Dockerfile.zkpassport-verifier",
  "image_build_context": ".."
}
```

Run deployment commands from this directory:

```bash
rtk bun install
rtk bun run deploy:staging
```

Before deploying an environment, set the shared secret:

```bash
rtk bunx wrangler secret put ZKPASSPORT_VERIFIER_SHARED_SECRET --env staging
```

Then point the API Worker at the deployed endpoint:

```text
ZKPASSPORT_VERIFIER_URL=https://pirate-zkpassport-verifier-container-staging.<workers-subdomain>.workers.dev/verify
ZKPASSPORT_VERIFIER_SHARED_SECRET=<same secret>
```

Production uses `deploy:production` and the production Worker name
`zkpassport-verifier-container`.

`ZKPASSPORT_VERIFIER_CONTAINER_INSTANCES` controls how many container-backed
Durable Object instances the Worker distributes requests across. Keep it less
than or equal to the matching `containers[].max_instances` value in
`wrangler.jsonc` for that environment. If it is higher, the Worker may select
container IDs that Cloudflare is not allowed to run.

## Endpoints

- `GET /health`
  Lightweight Worker health check. Does not start a container.
- `GET /health/container`
  Authenticated deep health check. Proxies to the container's `/health` endpoint
  and may start a container.
- `POST /verify`
  Authenticated proof verification endpoint used by the API Worker.

## Logging

The wrapper logs only operational metadata:

- forwarded/rejected verification events
- environment
- configured container instance count
- request content length
- rejection reason and latency

It does not log request bodies, proofs, query results, identifiers, nationality,
age, or gender values. The inner verifier service has the same redaction policy.
