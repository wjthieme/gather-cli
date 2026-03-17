# gather-cli

A small CLI for experimenting with the **Gather v2** (reverse‑engineered) API.

Includes:
- **`login`**: interactive Google OAuth login (opens a browser) and stores a Firebase refresh token locally
- **`music`**: updates your Gather custom status from **Apple Music** now playing (every 5s)
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
yarn start login
```

Optionally pass a space URL (or a raw space UUID) so subsequent commands don’t need arguments:

```bash
yarn start login "https://app.v2.gather.town/app/your-space-slug-<space-uuid>"
```

Then run any command:

```bash
yarn start music
yarn start dance
yarn start spin
```

## Credentials (`.auth`)

This project stores auth in a plain-text file at **`.auth`** (in your current working directory):

- **line 1**: Firebase **refresh token**
- **line 2** (optional): Gather **spaceId** (UUID)

If you want to switch spaces later, re-run `yarn start login <spaceUrl>` or edit line 2.

## Notes / requirements

- **Apple Music integration** (`music`) uses AppleScript (`osascript`), so it’s intended for **macOS**.
- The CLI uses Gather v2’s Firebase-backed auth and refreshes JWTs via Google’s securetoken endpoint.

## Debugging

Run with `DEBUG=1` to log token refresh, WebSocket connect/auth/subscription, and server messages:

```bash
DEBUG=1 yarn start music
```

## Build

```bash
yarn build
```

This outputs `dist/` and exposes the `gather` binary via `package.json`’s `bin` field.
