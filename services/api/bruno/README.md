# Bruno First Slice

This folder is the handoff for the first executable API-only flow against the live worker in `pirate-api/services/api`.

The initial Bruno target is the JWT path, not the Privy browser path.

This JWT path is also not the intended long-term human CLI login path. A future CLI flow should use a browser handoff or device-code-style session and then land on the same Pirate session model after backend exchange.

## Collection Layout

Suggested collection layout:

- `00-auth/session-exchange-jwt`
- `00-auth/get-users-me`
- `00-auth/get-onboarding-status`
- `01-verification/start-verification-session`
- `01-verification/get-verification-session`
- `01-verification/complete-verification-session`
- `02-namespace-verification/start-namespace-verification-session`
- `02-namespace-verification/get-namespace-verification-session`
- `02-namespace-verification/complete-namespace-verification-session`
- `02-namespace-verification/get-namespace-verification`
- `03-communities/create-community`
- `03-communities/get-job`
- `03-communities/get-community`
- `04-posts/create-post`
- `04-posts/create-post-idempotent-retry`
- `04-posts/get-post`
- `04-posts/create-post-review-required`
- `04-posts/get-review-held-post`
- `04-posts/create-post-blocked`
- `04-posts/get-community-posts`
- `90-failures/get-onboarding-status-without-token`
- `90-failures/session-exchange-expired-jwt`
- `90-failures/session-exchange-malformed-jwt`
- `90-failures/session-exchange-wrong-issuer`
- `90-failures/session-exchange-wrong-audience`
- `90-failures/get-users-me-without-token`
- `90-failures/start-verification-session-invalid-payload`
- `90-failures/start-namespace-verification-session-invalid-payload`
- `90-failures/create-community-invalid-payload`
- `90-failures/create-community-invalid-gender-provider`
- `90-failures/create-community-invalid-wallet-score-provider`
- `90-failures/create-post-invalid-payload`
- `90-failures/get-post-without-token`
- `90-failures/session-exchange-jwt-secondary`
- `90-failures/start-verification-session-secondary`
- `90-failures/complete-verification-session-secondary`
- `90-failures/create-post-verified-non-member`
- `90-failures/create-post-anonymous-missing-scope`
- `90-failures/create-post-link-missing-url`

This now covers the full first slice through first post creation.

## Environment Variables

Use these Bruno environment values:

- `base_url`
- `upstream_jwt`
- `upstream_jwt_secondary`
- `pirate_access_token`
- `pirate_user_id`
- `verification_session_id`
- `namespace_root_label`
- `namespace_verification_session_id`
- `namespace_verification_id`
- `community_display_name`
- `community_description`
- `community_id`
- `community_provisioning_job_id`
- `post_id`
- `song_post_id`
- `review_post_id`
- `post_idempotency_key`
- `post_title`
- `post_body`
- `post_locale`

Helpful failure-case env values:

- `upstream_jwt_expired`
- `upstream_jwt_malformed`
- `upstream_jwt_wrong_issuer`
- `upstream_jwt_wrong_audience`

The secondary-user failure flow also reuses the mutable auth state:

- `session-exchange-jwt-secondary` overwrites `pirate_access_token`
- `session-exchange-jwt-secondary` overwrites `pirate_user_id`
- the follow-up secondary verification requests act on that swapped user context

Optional diagnostic values:

- `jwt_issuer`
- `jwt_subject`

This folder now includes:

- `bruno.json`
- `environments/local.bru`
- happy-path requests for auth, verification, communities, and posts
- failure-case requests for each milestone

## Local Worker Setup

Before running the collection:

1. Prepare fresh local Bruno state:

```bash
cd pirate-api/services/api
rtk bun run bruno:prepare:local
```

This resets the local control-plane/community DBs and rewrites `environments/local.bru` with fresh JWT fixtures.

2. In `pirate-api/services/api/.dev.vars`, set:

```dotenv
ENVIRONMENT=development
DEV_MEMORY_STORE_ENABLED=false
AUTH_UPSTREAM_JWT_SHARED_SECRET=replace-me
AUTH_UPSTREAM_JWT_ISSUER=pirate-dev-upstream
AUTH_UPSTREAM_JWT_AUDIENCE=pirate-api
TURSO_CONTROL_PLANE_DATABASE_URL=file:/tmp/pirate-control-plane.db
LOCAL_COMMUNITY_DB_ROOT=/tmp/pirate-community-dbs
PIRATE_APP_JWT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----
replace-me
-----END PRIVATE KEY-----"
PIRATE_APP_JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----
replace-me
-----END PUBLIC KEY-----"
PIRATE_APP_JWT_ISSUER=pirate-api
PIRATE_APP_JWT_AUDIENCE=pirate-app
```

3. Start the Bun local server:

```bash
cd pirate-api/services/api
rtk bun run dev:local
```

4. Run the collection from the service repo wrapper:

```bash
cd pirate-api/services/api
rtk bun run bruno:test:local
```

This local Bruno path uses Bun rather than Wrangler because the first-slice local DBs are `file:`-backed.

## Execution Order

1. `POST /auth/session/exchange`
2. `GET /users/me`
3. `GET /onboarding/status`
4. `POST /verification-sessions`
5. `GET /verification-sessions/{verification_session_id}`
6. `POST /verification-sessions/{verification_session_id}/complete`
7. `POST /namespace-verification-sessions`
8. `GET /namespace-verification-sessions/{namespace_verification_session_id}`
9. `POST /namespace-verification-sessions/{namespace_verification_session_id}/complete`
10. `GET /namespace-verifications/{namespace_verification_id}`
11. `POST /communities`
12. `GET /jobs/{job_id}`
13. `GET /communities/{community_id}`
14. `POST /communities/{community_id}/posts`
15. `POST /communities/{community_id}/posts` with the same `idempotency_key`
16. `GET /posts/{post_id}`
17. `POST /communities/{community_id}/posts` with the local stub review trigger
18. `GET /posts/{review_post_id}`
19. `POST /communities/{community_id}/posts` with the local stub block trigger
20. `GET /communities/{community_id}/posts`
21. `POST /communities/{community_id}/posts` for a mainline song post
22. `GET /posts/{song_post_id}`
23. `POST /auth/session/exchange` with `upstream_jwt_secondary`
24. `POST /verification-sessions`
25. `POST /verification-sessions/{verification_session_id}/complete`
26. `POST /communities/{community_id}/posts` as a verified non-member
27. `POST /communities/{community_id}/posts` with `identity_mode = anonymous` and no `anonymous_scope`
28. `POST /communities/{community_id}/posts` with `post_type = link` and no `link_url`
29. `POST /communities/{community_id}/posts` with `post_type = song` and `identity_mode = anonymous`
30. `POST /communities/{community_id}/posts` with `post_type = song` and no `lyrics`
31. `POST /communities/{community_id}/posts` with `post_type = song` and no audio `media_refs`
32. `POST /communities/{community_id}/posts` with `post_type = song`, `song_mode = remix`, and `rights_basis != derivative`

The post path depends on the projection write. After a successful post create, validate in SQL that:

- one `posts` row exists in the community DB
- one `community_post_projections` row exists in the control-plane DB
- `projection_version = 1`
- `source_post_id` matches the returned `post_id`

## Secondary Failure Actor

The late `90-failures/*secondary*` mini-flow intentionally swaps the active Bruno auth context to a second verified user:

- `session-exchange-jwt-secondary` exchanges `upstream_jwt_secondary`
- its post-response script replaces `pirate_access_token`
- its post-response script replaces `pirate_user_id`
- `start-verification-session-secondary` and `complete-verification-session-secondary` then verify that second user

That leaves the collection in a deliberate "verified but not a member of the created community" state for `create-post-verified-non-member`.

The next two failure requests stay after that swap on purpose:

- `create-post-anonymous-missing-scope` is a structural payload validation failure
- `create-post-link-missing-url` is a structural payload validation failure
- the song validation failures are also structural payload validation failures

Those requests should still return `400 bad_request` even when the active auth context is now the secondary non-member, because request-shape validation runs before deeper posting eligibility checks.

## Request Shapes

### `POST /auth/session/exchange`

Request:

```json
{
  "proof": {
    "type": "jwt_based_auth",
    "jwt": "{{upstream_jwt}}"
  }
}
```

Success expectations:

- status `200`
- body contains `access_token`
- body contains `user`
- body contains `profile`
- body contains `onboarding`
- body contains `wallet_attachments`

Bruno post-response step:

- save `res.body.access_token` into `pirate_access_token`
- save `res.body.user.user_id` into `pirate_user_id`

### `GET /users/me`

Header:

```text
Authorization: Bearer {{pirate_access_token}}
```

Success expectations:

- status `200`
- body `user_id` matches the user returned by session exchange

### `GET /onboarding/status`

Header:

```text
Authorization: Bearer {{pirate_access_token}}
```

Success expectations:

- status `200`
- payload is present even for a newly created user

### `POST /communities`

Success expectations:

- status `202`
- body contains `community`
- body contains `job`
- post-response saves `community_id` and `community_provisioning_job_id`

### `POST /communities/{community_id}/posts`

Success expectations:

- status `201` in the local stub path
- body contains canonical `post_id`
- post-response saves `post_id`

Retry expectations:

- replaying the same request with the same `idempotency_key` returns `201`
- `post_id` remains unchanged

Local review-held expectations:

- sending `[review-required]` in post text triggers the local stub hold path
- status `202`
- canonical row persists with `status = draft`
- canonical row persists with `analysis_state = review_required`

Local blocked expectations:

- sending `[blocked]` in post text triggers the local stub blocked path
- status `422`
- body code is `analysis_blocked`
- no canonical post row is written

### `GET /communities/{community_id}/posts`

Success expectations:

- status `200`
- `items` contains published posts for the community
- locally review-held drafts do not appear in the list
- blocked creates do not leave feed-visible rows
- `resolved_locale` matches `post_locale` when requested
- `next_cursor` is `null` for the current single-page first-slice flow

### `GET /posts/{post_id}`

Success expectations:

- status `200`
- body contains `post`
- `body.post.post_id` matches the created post
- `resolved_locale` matches `post_locale`

The review-held read uses the same endpoint and should return the persisted canonical draft row.

In the current implemented surface, that non-published direct read is intentionally limited to the post author or the community owner. Other members should receive `404`.

### `POST /communities/{community_id}/posts` for a song

Success expectations:

- status `201`
- body contains canonical `post_id`
- `post_type = song`
- `identity_mode = public`
- `song_mode = original`
- `rights_basis = original`
- `lyrics` round-trip on the canonical post payload
- post-response saves `song_post_id`

### `GET /posts/{song_post_id}`

Success expectations:

- status `200`
- body contains `post`
- `body.post.post_id` matches `song_post_id`
- `body.post.post_type = song`
- `body.post.lyrics` matches the create payload
- `resolved_locale` matches `post_locale`

## Failure Cases

### Expired JWT

Use a token with an `exp` in the past.

Expected result:

- status `401`
- body shape:

```json
{
  "code": "auth_error",
  "message": "Authentication failed",
  "retryable": false
}
```

### Wrong issuer

Use a token with the wrong `iss`.

Expected result:

- status `401`
- body shape:

```json
{
  "code": "auth_error",
  "message": "Authentication failed",
  "retryable": false
}
```

### Wrong audience

Use a token with the wrong `aud`.

Expected result:

- status `401`
- body shape:

```json
{
  "code": "auth_error",
  "message": "Authentication failed",
  "retryable": false
}
```

### Malformed JWT

Use a syntactically invalid token or an otherwise unparsable JWT string.

Expected result:

- status `401`
- body shape:

```json
{
  "code": "auth_error",
  "message": "Authentication failed",
  "retryable": false
}
```

### Missing Pirate bearer token

Call `GET /users/me` without `Authorization`.

Expected result:

- status `401`
- body shape:

```json
{
  "code": "auth_error",
  "message": "Authentication failed",
  "retryable": false
}
```

The same expectation applies to any authenticated read without `Authorization`.

## Runtime Notes

The runtime repo should implement the JWT verification mode first. The first local slice should use HMAC verification with `AUTH_UPSTREAM_JWT_SHARED_SECRET`. Once that is working, Privy can be added as another request variant for the same `POST /auth/session/exchange` endpoint, and JWKS-backed upstream verification can be added when a real issuer exists.
