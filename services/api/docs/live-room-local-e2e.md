# Live Room Local E2E

This runbook exercises the local path that matters for the Freedom live room flow:

1. Mint a local dev user session.
2. Complete local verification.
3. Create a community.
4. Upload audio and create a song artifact bundle.
5. Verify the live setlist picker can find that bundle.
6. Create a ready solo live room using that bundle.
7. Print the anchor post URL and `freedom://live-room` URL for manual Freedom testing.

## Prerequisites

Run the API locally on `http://127.0.0.1:8787` and the web app on `http://localhost:5173`.

Set these API env values for a useful local attach:

```bash
PIRATE_WEB_PUBLIC_ORIGIN=http://localhost:5173
LIVE_ROOM_JACKTRIP_HOST=127.0.0.1
```

`LIVE_ROOM_JACKTRIP_HOST_TEMPLATE` also works if you want room-specific hostnames.

The script reads `services/api/.dev.vars`, so local JWT settings such as `AUTH_UPSTREAM_JWT_SHARED_SECRET` can live there.

## Run

From `services/api`:

```bash
rtk bun run live-room:e2e:local
```

Optional flags:

```bash
rtk bun run live-room:e2e:local -- --audio-file /path/to/song.wav
rtk bun run live-room:e2e:local -- --api-url http://127.0.0.1:8787 --web-url http://localhost:5173
rtk bun run live-room:e2e:local -- --subject live-room-local-test
rtk bun run live-room:e2e:local -- --dry-run
```

If `--audio-file` is omitted, the script uploads a one-second silent WAV. That is enough to test the API wiring, picker, setlist persistence, attach payload, and Freedom launch path.

On localhost, the script uses fast local upload and song bundle finalization by default after exercising the upload intent API. This avoids requiring Filebase credentials or waiting on OpenRouter, ACRCloud, or ElevenLabs while still testing the picker and live-room creation path against the local database.

To force the real song analysis route locally:

```bash
rtk bun run live-room:e2e:local -- --real-song-analysis
```

`--real-song-analysis` also uses the real upload-content route, so it requires configured Filebase credentials.

## Manual Freedom Check

After the script prints the URLs:

1. Open the anchor post URL in the web app and confirm the live room banner is present.
2. Open the printed `freedom://live-room?...` URL in Freedom.
3. Sign in from the Freedom live room page and approve the device in the web page.
4. Click `Host Attach`.
5. Confirm the JackTrip fields populate from the attach payload.
6. Click `End Room` and confirm the room transitions to ended.

For local browser navigation, use `http://localhost:5173`, not bare `localhost:5173`. Electron treats the bare form as a failed URL load.
