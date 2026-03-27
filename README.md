# gather-cli

> **Disclaimer — read this first**  
> This project is **vibe coded** (experimental, reverse‑engineered against Gather’s non‑public APIs, lightly tested, and maintained informally). **Nothing here is endorsed by Gather.** It may break at any time, leak or mishandle tokens, violate terms of service, or behave in ways you do not expect. **Use is entirely at your own risk.** Do not use it for anything safety‑critical or where misuse could harm you or others.

A small CLI for experimenting with the **Gather v2** API surface the authors inferred from traffic and behavior.

## Commands

| Command | Description |
|--------|-------------|
| **`login <spaceId-or-spaceUrl>`** | Interactive Google OAuth (opens a browser). Saves credentials under `~/.config/gather/auth.json`. |
| **`music`** | Updates your Gather custom status from **Apple Music** now playing (polls every 5s). **macOS** (AppleScript). |
| **`lyrics`** | Posts timed lyric lines from Apple Music to **nearby chat**, aligned to playback position. **macOS**. |
| **`dj`** | Guest flow: stream **system audio** (e.g. BlackHole) into Gather voice after the host admits the guest. See env vars below. **macOS**-oriented. |
| **`dance`** | Random walk + party emoji loop. |
| **`spin`** | Spin in place (`faceDirection` + emoji loop). |

### `dj` environment variables (optional)

- **`GATHER_GUEST_NAME`** — display name for the guest (default `DJ`).
- **`DJ_PORTAUDIO_BUFFER_MULTIPLIER`** — integer `1`–`8` for PortAudio buffer sizing (default `8`).

## Install

```bash
yarn install
```

## Usage (dev)

```bash
yarn start --help
```

Log in first (writes **`~/.config/gather/auth.json`**):

```bash
yarn start login <space-id-or-gather-space-url>
```

Then run any command:

```bash
yarn start music
yarn start lyrics
yarn start dj
yarn start dance
yarn start spin
```

## Credentials (`~/.config/gather/auth.json`)

Auth is stored as **JSON** (not a two-line `.auth` file):

- **`refreshToken`** (string) — Firebase refresh token from the login flow.
- **`spaceId`** (string, optional) — Gather space UUID; set at login or updated when you target a space.

`authUserId`, `spaceUserId`, and JWTs are **not** persisted; they are resolved at runtime from the API and WebSocket. To switch spaces, run `login` again with the new space URL/ID or edit `spaceId` in the JSON (you must still have a valid `refreshToken`).

## Notes / requirements

- Gather’s v2 API is **not a stable public contract**. **There is no guarantee this CLI will keep working.**
- **Apple Music** features (`music`, `lyrics`, and status display in `dj`) use AppleScript — **macOS** only.
- Auth uses Gather v2’s Firebase-backed flow (Google OAuth → refresh token; JWT refresh via Google securetoken and related Identity Toolkit calls as implemented in code).

## Debugging

```bash
yarn dev <command>
```

Dry-run (prints WebSocket send intentions; does not send game actions):

```bash
DRY=1 yarn start lyrics
```

## Build

```bash
yarn build
```

Outputs `dist/` and exposes the `gather` binary via `package.json`’s `bin` field.
