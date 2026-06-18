# Staging test issuer (operator runbook)

A dedicated, **staging-only** JWT issuer for driving authenticated validation (e.g. the
Turso→D1 write-cutover pilot) without minting real upstream tokens or touching the real
upstream auth path.

- Verifier: `src/lib/auth/staging-test-auth.ts` (`verifyStagingTestJwt`)
- Wired into: `POST /auth/session/exchange` via proof type `staging_test_jwt`
- Mint tool: `scripts/mint-staging-test-token.ts` (operator tooling, not a request path)
- Issuer: `pirate-staging-test-issuer` · Audience: `pirate-api-staging-test`
- Signing secret env: `STAGING_TEST_JWT_SHARED_SECRET` (HS256) — **separate from** the real
  `AUTH_UPSTREAM_JWT_SHARED_SECRET`
- Opt-in env: `STAGING_TEST_AUTH_ENABLED=true`

## Security model (do not weaken)

Fails closed — a token is accepted **only** when ALL hold:
1. `ENVIRONMENT=staging`
2. `STAGING_TEST_AUTH_ENABLED` is truthy
3. `STAGING_TEST_JWT_SHARED_SECRET` is set

If the secret ever reaches prod/dev, the environment + flag guards still reject every token
(covered by `staging-test-auth.test.ts`). The issuer/secret are never the real upstream ones,
so this path cannot mint trust for the real `pirate-staging-upstream` issuer.

## Enable (staging only)

1. Set the secret + flag in the staging secret store (Infisical `/services/api`, staging):
   - `STAGING_TEST_JWT_SHARED_SECRET=<random 32+ byte secret>`
   - `STAGING_TEST_AUTH_ENABLED=true`
2. Deploy the staging worker (`bunx wrangler@4.100.0 deploy --env staging`).
3. Mint + exchange a token for a known pilot owner:
   ```sh
   infisical run --project-config-dir ../../core --env staging --path /services/api -- \
     bun scripts/mint-staging-test-token.ts --sub usr_pilot_owner --exchange
   ```
   Use the printed `access_token` as `Authorization: Bearer <token>` for API calls.

## Rotate the key

1. Generate a new `STAGING_TEST_JWT_SHARED_SECRET`, update it in Infisical (staging only).
2. Redeploy the staging worker. Previously minted tokens (signed with the old secret) stop
   verifying immediately. Re-mint as needed.

## Remove entirely (when validation work is done)

1. In Infisical (staging): set `STAGING_TEST_AUTH_ENABLED=false` (kill switch — instantly
   disables the path) and delete `STAGING_TEST_JWT_SHARED_SECRET`.
2. Redeploy staging.
3. To remove the code: delete `src/lib/auth/staging-test-auth.ts`,
   `src/lib/auth/staging-test-auth.test.ts`, `scripts/mint-staging-test-token.ts`, the
   `staging_test_jwt` branch in `src/routes/auth.ts`, and the two env fields in `src/env.ts`.

## Notes

- Never set `STAGING_TEST_AUTH_ENABLED` or the secret in production or dev environments.
- Tokens are short-lived (default 900s, max 3600s) and scoped to a single subject.
- Exchanged identities are namespaced `pirate-staging-test-issuer|<sub>`, so they never
  collide with real upstream users.
