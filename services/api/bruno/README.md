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
- `03-communities/patch-community`
- `03-communities/get-community-profile`
- `03-communities/patch-community-profile`
- `03-communities/get-donation-policy`
- `03-communities/get-flairs`
- `03-communities/patch-donation-policy`
- `04-posts/create-post`
- `04-posts/create-post-idempotent-retry`
- `04-posts/get-post`
- `04-posts/create-post-review-required`
- `04-posts/get-review-held-post`
- `04-posts/create-post-blocked`
- `04-posts/get-community-posts`
- `04-posts/create-song-artifact-upload`
- `04-posts/upload-song-artifact-content`
- `04-posts/create-song-artifact-bundle`
- `04-posts/get-song-artifact-bundle`
- `04-posts/create-song-post`
- `04-posts/create-song-post-reused-bundle`
- `04-posts/get-song-post`
- `06-commerce/get-money-policy`
- `06-commerce/patch-money-policy`
- `06-commerce/get-pricing-policy`
- `06-commerce/patch-pricing-policy`
- `06-commerce/create-listing`
- `06-commerce/list-listings`
- `06-commerce/get-listing`
- `06-commerce/patch-listing`
- `06-commerce/purchase-quote-preflight`
- `06-commerce/create-purchase-quote`
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
- `05-membership/join-community`
- `05-membership/get-community-after-join`

This now covers the full first slice through first post creation, the post-create setup path community owners actually need, a minimal commerce configuration path, and the first non-creator membership transition.

## Environment Variables

Use these Bruno environment values:

- `base_url`
- `upstream_jwt`
- `upstream_jwt_secondary`
- `pirate_access_token`
- `pirate_access_token_member`
- `pirate_user_id`
- `pirate_user_id_member`
- `verification_session_id`
- `namespace_root_label`
- `namespace_verification_session_id`
- `namespace_verification_id`
- `community_display_name`
- `community_description`
- `community_id`
- `community_provisioning_job_id`
- `listing_id`
- `purchase_quote_id`
- `post_id`
- `song_artifact_upload_id`
- `song_artifact_upload_url`
- `song_artifact_bundle_id`
- `song_post_id`
- `review_post_id`
- `post_idempotency_key`
- `post_title`
- `post_body`
- `song_primary_audio_storage_ref`
- `song_primary_audio_size_bytes`
- `song_primary_audio_content_hash`
- `song_primary_audio_gateway_url`
- `song_lyrics`
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
- the post-validation failure requests use the original member token to keep `400` assertions independent of non-member authz order
- the later membership requests intentionally keep that verified secondary user and transition them from non-member to joined member

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
rtk bun run bruno:prepare:local-sqlite
```

This resets the local control-plane/community DBs and rewrites `environments/local.bru` with fresh JWT fixtures.

2. In `pirate-api/services/api/.env.local-sqlite`, set:

```dotenv
ENVIRONMENT=development
DEV_MEMORY_STORE_ENABLED=false
AUTH_UPSTREAM_JWT_SHARED_SECRET=replace-me
AUTH_UPSTREAM_JWT_ISSUER=pirate-dev-upstream
AUTH_UPSTREAM_JWT_AUDIENCE=pirate-api
CONTROL_PLANE_DATABASE_URL=file:/tmp/pirate-control-plane.db
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
rtk bun run dev:local-sqlite
```

4. Run the collection from the service repo wrapper:

```bash
cd pirate-api/services/api
rtk bun run bruno:test:local-sqlite
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
14. `PATCH /communities/{community_id}`
15. `GET /communities/{community_id}/community-profile`
16. `PATCH /communities/{community_id}/community-profile`
17. `GET /communities/{community_id}/donation-policy`
18. `GET /communities/{community_id}/flairs`
19. `PATCH /communities/{community_id}/donation-policy`
20. `POST /communities/{community_id}/posts`
21. `POST /communities/{community_id}/posts` with the same `idempotency_key`
22. `GET /posts/{post_id}`
23. `POST /communities/{community_id}/posts` with the local stub review trigger
24. `GET /posts/{review_post_id}`
25. `POST /communities/{community_id}/posts` with the local stub block trigger
26. `GET /communities/{community_id}/posts`
27. `POST /communities/{community_id}/song-artifact-uploads`
28. `PUT /communities/{community_id}/song-artifact-uploads/{song_artifact_upload_id}/content`
29. `POST /communities/{community_id}/song-artifacts`
30. `GET /communities/{community_id}/song-artifacts/{song_artifact_bundle_id}`
31. `POST /communities/{community_id}/posts` for a mainline song post
32. `POST /communities/{community_id}/posts` with the same song bundle and a new `idempotency_key`
33. `GET /posts/{song_post_id}`
34. `GET /communities/{community_id}/money-policy`
35. `PATCH /communities/{community_id}/money-policy`
36. `GET /communities/{community_id}/pricing-policy`
37. `PATCH /communities/{community_id}/pricing-policy`
38. `POST /communities/{community_id}/listings`
39. `GET /communities/{community_id}/listings`
40. `GET /communities/{community_id}/listings/{listing_id}`
41. `PATCH /communities/{community_id}/listings/{listing_id}`
42. `POST /communities/{community_id}/purchase-quote-preflight`
43. `POST /communities/{community_id}/purchase-quotes`
44. `POST /auth/session/exchange` with `upstream_jwt_secondary`
45. `POST /verification-sessions`
46. `POST /verification-sessions/{verification_session_id}/complete`
47. `POST /communities/{community_id}/posts` as a verified non-member
48. `POST /communities/{community_id}/posts` with `identity_mode = anonymous` and no `anonymous_scope`
49. `POST /communities/{community_id}/posts` with `post_type = link` and no `link_url`
50. `POST /communities/{community_id}/posts` with `post_type = song` and `identity_mode = anonymous`
51. `POST /communities/{community_id}/posts` with `post_type = song` and no `lyrics`
52. `POST /communities/{community_id}/posts` with `post_type = song` and no audio `media_refs`
53. `POST /communities/{community_id}/posts` with `post_type = song`, `song_mode = remix`, and `rights_basis != derivative`
54. `POST /communities/{community_id}/join`
55. `GET /communities/{community_id}`

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

After those negative checks, the membership requests join that same verified secondary user to the created community and confirm the follow-up community read still reports non-zero member counts for the joined flow.

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

### `POST /communities/{community_id}/song-artifact-uploads`

Success expectations:

- status `201`
- body contains canonical `song_artifact_upload_id`
- `status = pending_upload`
- `artifact_kind = primary_audio`
- post-response saves `song_artifact_upload_id` and `song_artifact_upload_url`

### `PUT /communities/{community_id}/song-artifact-uploads/{song_artifact_upload_id}/content`

Success expectations:

- status `200`
- body contains the same `song_artifact_upload_id`
- `status = uploaded`
- `storage_ref` becomes the canonical song audio ref
- `storage_provider = filebase` when Filebase credentials are configured, otherwise `local_stub`
- `gateway_url` uses the Filebase gateway for fast verification reads when the upload path is Filebase-backed
- post-response saves `song_primary_audio_storage_ref`, `song_primary_audio_size_bytes`, `song_primary_audio_content_hash`, and `song_primary_audio_gateway_url`

### `POST /communities/{community_id}/posts` for a song

Success expectations:

- status `201`
- body contains canonical `post_id`
- `post_type = song`
- `identity_mode = public`
- `song_mode = original`
- `rights_basis = original`
- request body uses `song_artifact_bundle_id` instead of duplicating `lyrics` and `media_refs`
- response echoes the canonical `song_artifact_bundle_id`
- `lyrics` and `media_refs` round-trip on the canonical post payload from the registered bundle
- after the first successful publish, the bundle becomes consumed and cannot be reused for a second new post
- post-response saves `song_post_id`

### `POST /communities/{community_id}/posts` for a song with a reused bundle

Failure expectations:

- status `400`
- body code is `bad_request`
- message is `Song artifact bundle has already been used`

### `POST /communities/{community_id}/song-artifacts`

Success expectations:

- status `201`
- body contains canonical `song_artifact_bundle_id`
- `status = ready`
- `primary_audio.storage_ref` matches the uploaded audio ref
- `media_refs` contains the normalized primary audio descriptor
- post-response saves `song_artifact_bundle_id`, `song_primary_audio_storage_ref`, and `song_lyrics`

### `GET /communities/{community_id}/song-artifacts/{song_artifact_bundle_id}`

Success expectations:

- status `200`
- body contains the same `song_artifact_bundle_id`
- `status = ready` before the song is published from it
- `body.primary_audio.storage_ref` matches the saved bundle env value
- `body.lyrics` matches the saved bundle env value

### `GET /posts/{song_post_id}`

Success expectations:

- status `200`
- body contains `post`
- `body.post.post_id` matches `song_post_id`
- `body.post.post_type = song`
- `body.post.song_artifact_bundle_id` matches the bundle used at create time
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
