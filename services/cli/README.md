# Pirate CLI

Command-line client for the first executable Pirate API slice.

## Scope

Implemented commands:

- `pirate auth login --jwt <token> [--base-url <url>]`
- `pirate auth me`
- `pirate auth logout`
- `pirate onboarding status`
- `pirate verify human start [--provider self|very]`
- `pirate verify human status --session-id <id>`
- `pirate verify human complete --session-id <id> [--attestation-id <id>] [--proof-hash <hash>] [--proof <proof>] [--provider-payload-ref <ref>]`
- `pirate verify namespace start <root>`
- `pirate verify namespace complete <session_id> [--restart-challenge]`
- `pirate verify namespace status <session_id|verification_id> [--kind session|verification|auto]`
- `pirate community create --display-name <name> --namespace-verification-id <id> [--description <text>]`
- `pirate community launch-spaces <@root> --display-name <name> [--description <text>] [--very-gate] [--publish] [--publisher-dir <path>] [--no-wait]`
- `pirate community finalize-spaces <session_id> --display-name <name> [--description <text>] [--very-gate] [--no-wait]`
- `pirate community get <community_id>`
- `pirate job get <job_id>`
- `pirate post create <community_id> --title <title> --body <body> [--idempotency-key <key>]`
- `pirate post get <post_id> [--locale <locale>]`

## Auth Storage

The CLI stores session state in:

`~/.config/pirate/auth.json`

Fields:

- `base_url`
- `access_token`
- `user_id`
- `issued_at`
- `expires_at`
- `token_type`

The file is written with mode `0600`.

## Usage

1. Start the API worker in `api/services/api`.
2. Mint an upstream JWT in the API service:

```bash
cd api/services/api
rtk bun run mint:dev-jwt --sub demo-subject-01
```

3. Log in through the CLI:

```bash
cd api/services/cli
rtk bun run src/index.ts auth login --jwt REPLACE_WITH_JWT
```

4. Continue through the terminal flow:

```bash
rtk bun run src/index.ts auth me
rtk bun run src/index.ts onboarding status
rtk bun run src/index.ts verify human start
rtk bun run src/index.ts verify human complete --session-id ver_xxx
rtk bun run src/index.ts verify namespace start demo-root
rtk bun run src/index.ts verify namespace complete nvs_xxx
rtk bun run src/index.ts community create --display-name "Demo Club" --namespace-verification-id nv_xxx
rtk bun run src/index.ts post create cmt_xxx --title "Hello" --body "From the CLI"
```

## Spaces Launch

`community launch-spaces` mirrors the web flow:

1. start a Spaces namespace verification session
2. publish the returned Fabric records with the local Spaces publisher
3. complete namespace verification
4. create the community
5. wait for the provisioning job unless `--no-wait` is passed

Without `--publish`, the command only prints the Fabric command to run. With `--publish`, it runs `go run . publish` in the Spaces publisher directory and relies on local `SPACES_WALLET_EXPORT` or `SPACES_SECRET_KEY_HEX`.
If the Fabric publish is done outside the CLI, use `community finalize-spaces` with the printed session id to complete verification and create the community.

```bash
rtk bun run src/index.ts community launch-spaces @human --display-name Human --very-gate
rtk bun run src/index.ts community launch-spaces @human --display-name Human --very-gate --publish
```

## Notes

- Phase 1 auth is `jwt_based_auth`. Device-code auth is not implemented yet.
- Output defaults to formatted JSON so the CLI stays audit-friendly.
