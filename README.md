# gather-cli

A small CLI for experimenting with the **Gather v2** (reverse‑engineered) API.

Includes:
- **`login`**: interactive Google OAuth login (opens a browser) and stores a Firebase refresh token locally
- **`music`**: updates your Gather custom status from **Apple Music** now playing (every 5s)
- **`lyrics`**: posts the current lyric line to Gather nearby chat, timed to current song position
- **`dance`**: random walk + 🎉 emote loop
- **`spin`**: rotate (faceDirection) + 🌀 emote loop

## Install

```bash
yarn install
```

## Usage (dev)

```bash
yarn start --help
```

Login first (stores credentials in `.auth`):

```bash
yarn start login <space-id>
```

Then run any command:

```bash
yarn start music
yarn start lyrics
yarn start dance
yarn start spin
```

## Credentials (`.auth`)

This project stores auth in a plain-text file at **`.auth`** (in your current working directory):

- **line 1**: Firebase **refresh token**
- **line 2**: Gather **spaceId** (UUID)

If you want to switch spaces later, re-run `yarn start login <spaceUrl>` or edit line 2.

## Notes / requirements

- This uses a **non-public / reverse‑engineered** Gather API. **There is no guarantee this CLI will keep working**. Gather may change the API at any time.
- **Apple Music integration** (`music`) uses AppleScript (`osascript`), so it’s intended for **macOS**.
- The CLI uses Gather v2’s Firebase-backed auth and refreshes JWTs via Google’s securetoken endpoint.

## Debugging

Run with debug logging to inspect token refresh, WebSocket connect/auth/subscription, and server messages:

```bash
yarn dev <command>
```

Dry-run mode (prints commands but does not send any WebSocket messages):

```bash
DRY=1 yarn start lyrics
```

## Build

```bash
yarn build
```

This outputs `dist/` and exposes the `gather` binary via `package.json`’s `bin` field.
