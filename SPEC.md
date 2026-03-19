# Gather v2 API Specification

Reverse‑engineered from **chrome.har** (web app: login, space, calendar, chat, files), **dance.har** (in-space: move, reactions, walk), and **chat.har** (nearby chat typing/message actions). All endpoints and WebSocket messages are MessagePack-encoded where noted.

**Base URLs:**
- REST: `https://api.v2.gather.town`
- WebSocket: `wss://game-router.v2.gather.town/gather-game-v2`

---

## 1. Authentication

### 1.1 Google OAuth (browser login)

- **Authorization URL:** `https://accounts.google.com/o/oauth2/v2/auth`
  - `client_id`: Gather’s OAuth client (e.g. `384507832813-a4kih5nnq730movqlpcofkooovg9ip4f.apps.googleusercontent.com`)
  - `redirect_uri`: `https://api.v2.gather.town/auth/signin/google/callback`
  - `response_type`: `id_token` or `code`
  - `scope`: `profile email` or `openid email profile`
  - `nonce`: optional

- **Callback:** User is sent to `https://api.v2.gather.town/auth/signin/google/callback` with hash fragment containing `id_token` (JWT) or query with `code`.

### 1.2 Gather auth token exchange (chrome.har)

**POST** `https://api.v2.gather.town/api/v2/auth/google/token`

- **Request (JSON):** `{ "authCode": "<oauth_authorization_code>" }`
- **Response (JSON):** `{ "token": "<jwt>" }` — JWT for Gather/Firebase (issuer `securetoken.google.com/gather-town-v2` or Firebase admin SDK).

Used when the app exchanges an OAuth code for a Gather JWT. For CLI login we use Firebase Identity Toolkit with `id_token` instead (see below).

### 1.3 Firebase Identity Toolkit (CLI login)

**POST** `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=<API_KEY>`

- **Request (JSON):**
  - `requestUri`: Gather’s redirect URI (`https://api.v2.gather.town/auth/signin/google/callback`)
  - `returnSecureToken`: `true`
  - `postBody`: `id_token=<google_id_token>&providerId=google.com`

- **Response (JSON):** Includes `refreshToken`, `idToken` (JWT), `expiresIn`. The `refreshToken` is stored and used to obtain new JWTs.

### 1.4 Firebase Secure Token (JWT refresh)

**POST** `https://securetoken.googleapis.com/v1/token?key=<API_KEY>`

- **Request (x-www-form-urlencoded):**
  - `grant_type`: `refresh_token`
  - `refresh_token`: from signInWithIdp response

- **Response (JSON):** `id_token` (JWT), `refresh_token` (optional new), `expires_in`. JWTs are used as Bearer tokens for REST and in WebSocket `Authenticate`.

---

## 2. REST API (api.v2.gather.town)

All REST requests that require auth use **Bearer &lt;JWT&gt;** in `Authorization`. CORS preflight: **OPTIONS** on same path returns 204.

### 2.1 User

**GET** `/api/v2/users/me`

- **Query (optional):** `spaceId=<uuid>` — when present, response may include a `token` (JWT) for that space.
- **Response (JSON):**
  - `userAccount`: `{ id, email, hubSpotContactId, firebaseAuthId, selectedLanguage }`
  - `serverRegion`: e.g. `"us-east-1"`
  - `token`: (optional) JWT when `spaceId` was provided

Use `userAccount.firebaseAuthId` as **authUserId** for the WebSocket URL.

### 2.2 Space

**GET** `/api/v2/spaces/:spaceId`

- **Response (JSON):** `{ "exists": true }` (or similar).

### 2.3 Space – calendar / identity (spaceUserId)

**GET** `/api/v2/spaces/:spaceId/users/me/base-calendar-events`

- **Response:** MessagePack (or JSON). Contains calendar/status data; **spaceUserId** appears in the decoded payload (e.g. under `spaceUserId` or in nested objects). Required for in-space WebSocket actions (e.g. move, setCustomStatus, broadcastEmote).

**POST** `/api/v2/spaces/:spaceId/users/me/base-calendar-events/sync`

- **Request/Response:** (observed in chrome.har; exact body not fully documented here.)

### 2.4 Space – files

**GET** `/api/v2/spaces/:spaceId/files/:fileId`

- **Response (JSON):** `{ "url": "<signed_S3_or_CDN_url>" }`

### 2.5 Space – chat

**GET** `/api/v2/spaces/:spaceId/chat/channels`
**GET** `/api/v2/spaces/:spaceId/chat/activity-feed`

- **Response:** MessagePack (or binary). Activity feed and channel list.

**POST** `/api/v2/spaces/:spaceId/chat/channels`

- **Request (JSON):** e.g. `{ "type": "DirectMessage", "memberIds": [] }`
- **Response:** May return 403 (e.g. "Direct messages are disabled for this space").

### 2.6 Space – Gather AI

**GET** `/api/v2/spaces/:spaceId/gather-ai/channels`

- **Response:** MessagePack/binary (channel data).

### 2.7 Global

**GET** `/api/v2/space-templates`

- **Response (JSON):** Array of template objects, each with `id`, `spaceId`, `numberOfDesks`, `deskType`, `officeStyle`, `floors`, `spacePreviewUrl`, etc. These are **template** space IDs, not the user’s spaces.

### 2.8 Other (chrome.har)

- **POST** `/api/v2/integrations/cloudflare/siteverify` — body includes `cf_token`; response `{ "success": true }`.
- **POST** `/api/v2/releases/browser/Chrome/<version>/latest` — client/version check; response `{ "broken": false, "outdated": false }`.
- **POST** `/api/v2/newrelic/custom-events` — analytics.

---

## 3. WebSocket (game-router.v2.gather.town)

**URL:** `wss://game-router.v2.gather.town/gather-game-v2?spaceId=<uuid>&authUserId=<firebaseAuthId>`

- **spaceId:** UUID of the space.
- **authUserId:** `userAccount.firebaseAuthId` from `GET /api/v2/users/me`.

Frames are **MessagePack**-encoded. Client sends a sequence: **Authenticate** → **ConnectToSpace** → **Subscribe** → (after first server message) **loadSpaceUser** → **enterSpace**, then any **Action** messages.

### 3.1 Client → Server (control messages)

**Authenticate**

```json
{
  "type": "Authenticate",
  "credential": { "type": "JWT", "jwt": "<jwt>" }
}
```

**ConnectToSpace**

```json
{
  "type": "ConnectToSpace",
  "spaceId": "<uuid>",
  "connectionData": { "type": 4, "data": {} }
}
```

In HAR, `connectionData.data` is sometimes an empty buffer; implementations may use `{}` or empty buffer.

**Subscribe**

```json
{ "type": "Subscribe" }
```

**Heartbeat** (dance.har)

```json
{
  "type": "Heartbeat",
  "timestamp": <ms>,
  "sequenceNumber": { "type": 4, "data": [] },
  "origin": "Client"
}
```

### 3.2 Client → Server (actions)

All actions use the same envelope:

```json
{
  "type": "Action",
  "txnId": "<uuid>",
  "action": "<actionName>",
  "args": [ ... ]
}
```

**loadSpaceUser** (chrome.har, dance.har) — required before enterSpace.

- **args:** `["SpaceUser", null, { "connectionTarget": "OfficeView", "invitationId": { "type": 4, "data": {} }, "spawnAreaId": { "type": 4, "data": {} } }]`

**enterSpace** (chrome.har, dance.har) — required before setCustomStatus / move / broadcastEmote.

- **args:** `["SpaceUser", "<spaceUserId>"]`

**setCustomStatus** (chrome.har / codebase) — custom status line + emoji (e.g. “Now playing”).

- **args:** `["SpaceUser", "<spaceUserId>", { "text": "<string>", "clearCondition": { "type": "Never" }, "emoji": "<emoji>" }]`

**clearCustomStatus** (chrome.har / codebase)

- **args:** `["SpaceUser", "<spaceUserId>"]`

**move** (dance.har)

- **args:** `["SpaceUser", "<spaceUserId>", { "direction": "Up" | "Down" | "Left" | "Right" }]`

**walk** (dance.har)

- **args:** `["SpaceUser", "<spaceUserId>"]`

**broadcastEmote** (dance.har) — in-space “reaction” (e.g. party emoji).

- **args:** `["SpaceUser", "<spaceUserId>", { "emote": "<emoji>", "count": 1, "ambientlyConnectedUserIds": ["<spaceUserId>"] }]`

**broadcastTransientTyping** (chat.har) — nearby chat typing indicator.

- **args:** `["SpaceUser", "<spaceUserId>", { "isTyping": true | false, "ambientlyConnectedUserIds": ["<spaceUserId>"] }]`

**broadcastMessage** (chat.har) — nearby chat message to ambiently connected users.

- **args:** `["SpaceUser", "<spaceUserId>", { "message": { "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "<message>" }] }] }, "ambientlyConnectedUserIds": ["<spaceUserId>"] }]`

**faceDirection** (dance.har)

- **args:** `["SpaceUser", "<spaceUserId>", "<direction>"]`
- **direction:** e.g. `"Up"`.

**drive** (dance.har)

- **args:** `["SpaceUser", "<spaceUserId>"]`

**clearCalendarInferredStatus** (dance.har)

- **args:** `["SpaceUser", "<spaceUserId>"]`

**updateTargetMeetingArea** (dance.har)

- **args:** `["SpaceUser", "<spaceUserId>", {}]`

**createMemberGeneralInvite** (dance.har)

- **args:** `["SpaceInvitation", null]`

**getAuthenticationData** (dance.har)

- **args:** `["SpotifyOAuthUserSecret", null]`

### 3.3 Server → Client

Server sends MessagePack frames; observed types include:

- **Heartbeat** — keepalive.
- **ActionReturns** / **actionReturns** — correlates to client `txnId` and returns results or errors.
- **error** — error message in the same frame when present.

Exact response schemas are not fully enumerated here; implementers should log and handle `actionReturns` and `error` per action.

---

## 4. Identifiers

| ID            | Source | Use |
|---------------|--------|-----|
| **spaceId**   | App URL path (e.g. `/app/<slug>-<uuid>`), or stored after login | REST paths, WebSocket URL, ConnectToSpace |
| **authUserId** | `GET /api/v2/users/me` → `userAccount.firebaseAuthId` | WebSocket URL query |
| **spaceUserId** | `GET /api/v2/spaces/:spaceId/users/me/base-calendar-events` (decode msgpack, find `spaceUserId`) | All in-space WebSocket actions (move, setCustomStatus, broadcastEmote, etc.) |

No REST endpoint in the captured HARs returns a list of the user’s spaces; the space ID is derived from the app URL or from login flow (e.g. redirect or user input).

---

## 5. Content types

- **REST:** JSON for most request/response bodies. Some endpoints (e.g. base-calendar-events, chat, gather-ai) return **MessagePack**; `Content-Type` may include `application/x.gather.msgpack` or similar.
- **WebSocket:** All frames are **MessagePack** (binary).
