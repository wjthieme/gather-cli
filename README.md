# Music Status → Gather v2

Syncs **Apple Music** now-playing to your **Gather v2** custom status every 5 seconds. Uses the v2 WebSocket protocol only (`game-router.v2.gather.town`).

## Setup

```bash
yarn install
yarn start
```

**First run (no refresh token):** the app will print instructions. Gather v2 uses in-app Firebase auth (no OAuth redirect), so you log in in the browser and export a HAR:

1. Open **https://app.v2.gather.town** in a browser (incognito is fine), open your space, and sign in with Google.
2. In DevTools → Network: enable "Preserve log", then set or clear your status once.
3. Save all as HAR (e.g. **chrome.har**).
4. Run: **`node scripts/extract-from-har.js chrome.har`**  
   This writes the Firebase **refresh token** and **spaceId**, **authUserId**, **spaceUserId** to `.gather-credentials.json`.
5. Run **`yarn start`** again.

## Credentials

All required Gather data lives in **`.gather-credentials.json`** (from the HAR script): **refreshToken**, **spaceId**, **authUserId**, **spaceUserId**.

## Token refresh (v2)

Gather v2 uses **Firebase Auth** (issuer `securetoken.google.com/gather-town-v2`). The script refreshes the JWT via Firebase’s endpoint:

- `POST https://securetoken.googleapis.com/v1/token?key=...` with `grant_type=refresh_token` and `refresh_token=...`.

The default API key is the one used by the Gather v2 app (from the identitytoolkit request). To override:

- `GATHER_V2_FIREBASE_API_KEY` – Firebase Web API key for the gather-town-v2 project.

## Debug mode

Set **DEBUG=1** when running to log each tick: Apple Music state, JWT (cached vs refreshed), WebSocket connect/open/send, and server messages. Useful when the status isn’t updating.

```bash
DEBUG=1 yarn start
```

If the status still doesn’t update, check:

- **JWT vs auth user:** The app checks that the JWT’s `user_id`/`sub` (Firebase UID) matches `authUserId` in credentials. If they don’t, you’ll get an account mismatch error. With a single-session HAR export, they will match.
- **Troubleshooting:** If you only see Heartbeat messages and “Previous status update may have failed”, the server is not sending SpaceStatus/DeltaState to this connection and is not confirming setCustomStatus. The cause is unknown (could be connection state, message format, or server behaviour). Closing the Gather tab and running only the script is one thing to try; otherwise you’d need to inspect the v2 protocol or server behaviour further.

## Behaviour

- Every **5 seconds**:
  - Reads the current track from **Apple Music** via AppleScript.
  - Refreshes the Gather v2 bearer token if necessary.
  - Connects to `wss://game-router.v2.gather.town/gather-game-v2`, sends **Authenticate** (JWT), **ConnectToSpace**, **Subscribe**.
  - If something is playing: sends **setCustomStatus** with “Artist – Title” and the music-note emoji, **no expiration**.
  - If nothing is playing (or paused): sends **clearCustomStatus** to clear the status.

All WebSocket messages use **MessagePack** as in your v2 protocol analysis.
