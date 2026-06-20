# Song Preview Container

Cloudflare Container wrapper for paid-song MP3 preview generation.

The API Worker cannot run native `ffmpeg`, so scheduled
`song_preview_generate` jobs call this Worker over HTTPS. The wrapper authenticates
and forwards small JSON job requests into a Bun container that runs
`services/api/scripts/song-preview-service.ts`.

## Request Path

```text
pirate-api scheduled Worker
  -> service binding or HTTPS fetch to this Worker /preview
  -> container-enabled Durable Object
  -> Bun container /preview
  -> generateSongPreviewForBundle()
  -> Filebase + control plane DB update
```

The API Worker and this container Worker both use `SONG_PREVIEW_SHARED_SECRET` as
a bearer token. The wrapper rejects unauthenticated or oversized requests before
waking a container.

## Configuration

The Docker image installs native `ffmpeg` and reuses the API service dependency
graph:

```jsonc
{
  "image": "../api/Dockerfile.song-preview",
  "image_build_context": ".."
}
```

Container secrets:

```text
SONG_PREVIEW_SHARED_SECRET
CONTROL_PLANE_DATABASE_URL
FILEBASE_S3_ACCESS_KEY
FILEBASE_S3_SECRET_KEY
```

Container vars:

```text
FILEBASE_S3_ENDPOINT
FILEBASE_S3_REGION
FILEBASE_MEDIA_BUCKET
PIRATE_API_PUBLIC_ORIGIN
IPFS_GATEWAY_URL
SONG_PREVIEW_FFMPEG_BIN=ffmpeg
```

Staging and production bind the API Worker to this Worker with
`SONG_PREVIEW_SERVICE`, so the API does not need to know the account's
workers.dev subdomain. For manual deployments or local experiments, the API can
also use a URL:

```text
SONG_PREVIEW_SERVICE_URL=https://pirate-song-preview-container-staging.<workers-subdomain>.workers.dev/preview
SONG_PREVIEW_SHARED_SECRET=<same secret>
```

Production uses `deploy:production` and the production Worker name
`song-preview-container`.

Production/staging deploy order:

1. Set `SONG_PREVIEW_SHARED_SECRET` on both the API Worker and this Worker.
2. Set this Worker's storage/database secrets:
   `CONTROL_PLANE_DATABASE_URL`, `FILEBASE_S3_ACCESS_KEY`,
   `FILEBASE_S3_SECRET_KEY`.
3. Deploy this Worker first so the API service binding has a live target.
4. Deploy the API Worker after this Worker.

The workspace deploy scripts perform these checks and deploy this Worker before
the API. If `song_preview_generate` jobs are queued in prod but never complete,
first verify those secrets exist on both Workers and that `song-preview-container`
has been deployed.

## Endpoints

- `GET /health`
  Lightweight Worker health check. Does not start a container.
- `GET /health/container`
  Authenticated deep health check. Proxies to the container's `/health` endpoint
  and may start a container.
- `POST /preview`
  Authenticated preview generation endpoint used by the API Worker.

## Logging

Logs include request id, community id, bundle id, content length, outcome, and
latency. They do not log Filebase credentials, audio bytes, signed URLs, or raw
request bodies.
