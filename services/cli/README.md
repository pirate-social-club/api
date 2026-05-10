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
- `pirate verify namespace start <root|@root>`
- `pirate verify namespace complete <session_id> [--restart-challenge]`
- `pirate verify namespace status <session_id|verification_id> [--kind session|verification|auto]`
- `pirate community create --display-name <name> --namespace-verification-id <id> [--description <text>]`
- `pirate community launch-spaces <@root> --display-name <name> [--description <text>] [--very-gate] [--publish] [--publisher-dir <path>] [--no-wait]`
- `pirate community finalize-spaces <session_id> --display-name <name> [--description <text>] [--very-gate] [--no-wait]`
- `pirate community get <community_id>`
- `pirate community lookup <community_id|@slug>`
- `pirate community update <community_id> [--display-name <name>] [--description <text>] [--clear-description]`
- `pirate community preview <community_id> [--locale <locale>]`
- `pirate community rules set <community_id|@slug> --file <rules.txt|rules.json>`
- `pirate community gates set <community_id|@slug> (--file <gates.json>|--self-nationality <ISO2|ISO3>)`
- `pirate community links set <community_id|@slug> --file <links.json>`
- `pirate community labels set <community_id|@slug> --file <labels.json>`
- `pirate community safety set <community_id|@slug> --file <safety.json>`
- `pirate community donation-policy set <community_id|@slug> --file <donation.json>`
- `pirate community seed-post <community_id|@slug> (--as <alias>|--as-user-id <usr_...>) --idempotency-key <key> (--body <text>|--body-file <file>) [--title <title>] [--title-file <file>] [--visibility public|members_only] [--accounts-file <path>]`
- `pirate community seed-comment <community_id|@slug> <post_id> (--as <alias>|--as-user-id <usr_...>) --idempotency-key <key> (--body <text>|--body-file <file>) [--accounts-file <path>]`
- `pirate community join <community_id|@slug> [--as <alias>|--as-user-id <usr_...>] [--note <text>]`
- `pirate community follow <community_id|@slug> [--as <alias>|--as-user-id <usr_...>]`
- `pirate community members <community_id|@slug> [--locale <locale>]`
- `pirate community accounts provision-batch --file <accounts.json> [--accounts-file <path>] [--admin-token <token>] [--base-url <url>]`
- `pirate community apply <folder|manifest.json> [--community-id <id>] [--dry-run] [--allow-vote-seed]`
- `pirate job get <job_id>`
- `pirate post create <community_id> --title <title> --body <body> [--idempotency-key <key>]`
- `pirate post get <post_id> [--locale <locale>]`
- `pirate post vote <post_id> --value <1|-1> [--as <alias>|--as-user-id <usr_...>]`
- `pirate comment vote <comment_id> --value <1|-1> [--as <alias>|--as-user-id <usr_...>]`
- `pirate profile me [--as <alias>|--as-user-id <usr_...>]`
- `pirate profile update [--as <alias>|--as-user-id <usr_...>] [--file <profile.json>] [--display-name <name>] [--bio <text>|--bio-file <file>] [--preferred-locale <locale>]`

## Auth Storage

The CLI stores session state in:

`~/.config/pirate/auth.json`

User session fields:

- `mode`: `"user"`
- `base_url`
- `access_token`
- `user_id`
- `issued_at`
- `expires_at`
- `token_type`

Admin session fields:

- `mode`: `"admin"`
- `base_url`
- `admin_token`
- `admin_as_user_id`
- `user_id`

The file is written with mode `0600`.

## Seed Account Aliases

Seed account aliases are stored in `~/.config/pirate/seed-accounts.json`:

```json
{
  "editorial": "usr_abc123",
  "curator": "usr_def456",
  "lantern": {
    "user_id": "usr_ghi789",
    "provider": "bot_wallet",
    "communities": ["@example"]
  }
}
```

Used with `--as <alias>` in `seed-post`. Override with `--accounts-file <path>`.

## Admin Mode

Switch to admin mode to manage any community:

```bash
pirate auth admin-login --admin-token <token> --as-user <usr_...> --base-url https://api.pirate.sc
```

The `--as-user` sets the default acting user for admin operations. All admin mutations are audit-logged server-side.

After login, all community commands work as normal but with operator authority:

```bash
pirate community lookup @xn--t77hga
pirate community attach-namespace cmt_xxx --namespace-verification-id nv_xxx
pirate community rules set @xn--t77hga --file rules.txt
pirate community gates set @xn--t77hga --self-nationality PSE
pirate community seed-post @xn--t77hga --as editorial --idempotency-key welcome-001 --body-file posts/welcome.md
pirate community seed-comment @xn--t77hga pst_123 --as editorial --idempotency-key welcome-comment-001 --body-file comments/welcome.md
pirate post vote pst_123 --as curator --value 1
pirate profile update --as editorial --display-name "Editorial Desk" --bio-file profiles/editorial.md
```

Switch back to a normal user session with `pirate auth login`.

## Community Manifests

`community apply` reads a folder with `community.yaml` or a self-contained JSON manifest file and applies all settings in sequence. If the manifest does not include `community_id`, apply resolves `route_slug`/`namespace` first. If lookup returns 404 and the manifest includes `display_name` plus `namespace_verification_id`, it creates the community, waits for provisioning, then applies the remaining settings and seed operations.

```
pirate-communities/
  @xn--t77hga/
    community.yaml
    description.txt
    rules.txt
    links.json
    labels.json
    safety.json
    donation.json
    seed-accounts.json
    seed-posts.json
    seed-comments.json
```

`community.yaml` is a flat key-value manifest. Nested objects, YAML arrays, and multiline YAML strings are not supported; put structured data in JSON sidecar files.

A JSON manifest uses the same top-level fields, but can inline the seed arrays instead of using sidecar references:

```json
{
  "community_id": "cmt_xxx",
  "seed_accounts": {
    "lantern": {
      "user_id": "usr_abc123",
      "provider": "bot_wallet"
    }
  },
  "joins": [{ "as": "lantern" }],
  "seed_comments": [{
    "as": "lantern",
    "post_id": "pst_xxx",
    "idempotency_key": "example-idempotency-key-do-not-use",
    "body": "This is the part people keep skipping."
  }]
}
```

Inline keys are `seed_accounts`, `profile_updates`, `joins`, `follows`, `seed_posts`, `seed_comments`, `post_votes`, and `comment_votes`. Do not specify an inline key and its `_file` variant together. Paths inside inline items, such as `body_file` or `bio_file`, resolve relative to the JSON manifest file.

If `community.yaml` is absent, `community apply` uses the standard community folder convention directly:

```text
@example/
  name.txt
  description.txt
  rules.txt
  gates.json
  links.json
  labels.json
  safety.json
  donation.json
  seed-accounts.json
  seed-posts.json
  seed-comments.json
```

The folder name is used as the lookup identifier when it starts with `@`. `name.txt` updates the display name, `description.txt` updates the description, and the remaining files map to the same setting/seed steps as the manifest fields below. To create from a conventional folder, add `namespace-verification-id.txt`; otherwise the folder is treated as an update for an existing community.

`community.yaml` format:

```yaml
community_id: cmt_xxx
route_slug: @example
display_name: Example
namespace_verification_id: nv_xxx
membership_mode: open
human_verification_lane:
description_file: description.txt
rules_file: rules.txt
reference_links_file: links.json
labels_file: labels.json
safety_file: safety.json
donation_policy_file: donation.json
seed_accounts_file: seed-accounts.json
profile_updates_file: profile-updates.json
joins_file: joins.json
follows_file: follows.json
seed_posts_file: seed-posts.json
seed_comments_file: seed-comments.json
post_votes_file: post-votes.json
comment_votes_file: comment-votes.json
```

All fields are optional, except create requires both `display_name` and `namespace_verification_id`. Referenced files must exist; dry-run validates the manifest before any mutation. Apply order: lookup/create, namespace attach, description, gates, rules, links, labels, safety, donation-policy, profile updates, joins, follows, seed posts, seed comments, post votes, comment votes.

Create is intentionally idempotent by lookup: use `community_id` for a known target, or `route_slug`/`namespace` for a namespace-backed target. A folder name beginning with `@` is also used as a fallback lookup identifier. The CLI only calls create after lookup misses.

Seed sidecar files are JSON arrays or objects with a matching array key. Seed posts and seed comments require `idempotency_key`. A seed post can declare `alias`, and later seed comments or post votes can target it with `post_alias`. A seed comment can declare `alias`, and later comment votes can target it with `comment_alias`. Vote sidecars require `--allow-vote-seed`, including dry-runs.

`seed-posts.json`:

```json
[
  {
    "as": "editorial",
    "alias": "welcome",
    "idempotency_key": "welcome-001",
    "title": "Welcome",
    "body_file": "posts/welcome.md"
  }
]
```

`seed-comments.json`:

```json
[
  {
    "as": "curator",
    "alias": "welcome-reply",
    "idempotency_key": "welcome-reply-001",
    "post_alias": "welcome",
    "body_file": "comments/welcome.md"
  }
]
```

`comment-votes.json`:

```json
[
  {
    "as": "editorial",
    "comment_alias": "welcome-reply",
    "value": 1
  }
]
```

```bash
pirate community apply ./pirate-communities/@xn--t77hga --dry-run
pirate community apply ./pirate-communities/@xn--t77hga --community-id cmt_xxx
pirate community apply ./pirate-communities/@xn--t77hga/incremental-comments.json --dry-run
```

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
rtk bun run src/index.ts verify namespace start @demo-space
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
