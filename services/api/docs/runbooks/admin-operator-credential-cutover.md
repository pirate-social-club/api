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

The shared `X-Admin-Token` path remains temporarily available for migration.
Every use emits `legacy_admin_token_used`; production configuration emits
`legacy_admin_token_configured_in_production`. Before 2026-10-01:

1. Issue short-lived, least-privilege credentials for each operator identity.
2. Move callers to the `Operator` authorization scheme.
3. Confirm both legacy telemetry codes remain at zero for an agreed observation
   window.
4. Remove `PIRATE_ADMIN_TOKEN`, then delete the compatibility path.

Audit records use the credential's `operator_actor_id`; expiry and throttled
`last_used_at` updates come from `operator_credentials`.
