# Admin operator credential cutover

Administrative API access uses expiring `Operator <credential-id>.<secret>`
credentials. Grant only the capabilities needed by the caller:

- `admin:users:act_as` permits routes that require `X-Admin-As-User-Id`.
- `admin:users:manage` permits bot-user provisioning and token operations.
- `admin:operations:manage` permits operational diagnostics and repair routes.
- `admin:debug:access` permits non-production debug routes.

Issue credentials with `scripts/operator-credentials.ts` using the control-plane
migrator database URL. Multi-scope credentials require an explicit environment
variable name. Send the resulting credential in the `Authorization` header.
Never put it in query parameters or logs.

Production rejects `X-Admin-Token` outright. The legacy comparison remains only
for test and staging fixtures that have not yet been rewritten; it is never
reachable by a production Worker. All production and scheduled callers use the
operator scheme, and `PIRATE_ADMIN_TOKEN` is no longer read by production auth.

Audit records use the credential's `operator_actor_id`; expiry and throttled
`last_used_at` updates come from `operator_credentials`.
