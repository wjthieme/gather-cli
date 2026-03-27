# Gather v2 API Specification

This document describes the Gather **v2** HTTP API and real-time protocols used by **app.v2.gather.town** and **api.v2.gather.town**, as inferred from the production web client and this CLI. WebSocket payloads are **MessagePack**-encoded where noted.

**Note:** Do **not** rely on legacy npm packages branded `@gathertown/*` for protocol truth—they target Gather **v1**. This CLI targets **v2** (`app.v2.gather.town`, `api.v2.gather.town`, `game-router.v2.gather.town`, `router.v2.gather.town`).

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

### 1.2 Gather auth token exchange

**POST** `https://api.v2.gather.town/api/v2/auth/google/token`

- **Request headers:** `Authorization: Bearer <bootstrap_firebase_idToken>`
- **Request (JSON):** `{ "authCode": "<oauth_authorization_code>" }`
- **Response (JSON):** `{ "token": "<customToken>", ... }` where `token` is a Firebase **custom token** (admin-signed; issuer resembles Firebase admin service account, not securetoken).

Calling this endpoint without a valid bearer session returns **403**. The web client first creates an anonymous Firebase session and uses that `idToken` as the bearer.

### 1.3 Firebase Identity Toolkit (custom token sign-in)

**POST** `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=<API_KEY>`

- **Request (JSON):**
  - `token`: custom token returned by `POST /api/v2/auth/google/token`
  - `returnSecureToken`: `true`

- **Response (JSON):** Includes `refreshToken`, `idToken` (JWT), `expiresIn`.
- Resulting `idToken` has `firebase.sign_in_provider = "custom"` and includes `gather.userAccountId` claim.

### 1.4 Firebase Identity Toolkit (bootstrap anonymous session)

**POST** `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=<API_KEY>`

- **Request (JSON):**
  - `returnSecureToken`: `true`
- **Response (JSON):** Includes anonymous `idToken` and `refreshToken`.
- That anonymous `idToken` is then used as bearer auth for `POST /api/v2/auth/google/token`.

### 1.5 Firebase Secure Token (JWT refresh)

**POST** `https://securetoken.googleapis.com/v1/token?key=<API_KEY>`

- **Request (x-www-form-urlencoded):**
  - `grant_type`: `refresh_token`
  - `refresh_token`: from signInWithIdp response

- **Response (JSON):** `id_token` (JWT), `refresh_token` (optional new), `expires_in`.
- JWTs are used as Bearer tokens for REST and in WebSocket `Authenticate`.

### 1.6 End-to-end login flow for voice token

Observed working sequence to obtain a voice-capable token chain:

1. Google OAuth redirect callback provides `code` at `.../auth/signin/google/callback?code=...`.
2. `POST accounts:signUp` to mint anonymous bootstrap `idToken`.
3. `POST /api/v2/auth/google/token` with:
   - `Authorization: Bearer <anonymous_idToken>`
   - body `{ "authCode": "<code>" }`
4. Receive `{ token: <customToken> }`.
5. `POST accounts:signInWithCustomToken` using that custom token.
6. Store resulting `refreshToken` and refresh via `securetoken` as usual.

---

## 2. REST API (api.v2.gather.town)

All REST requests that require auth use **Bearer &lt;JWT&gt;** in `Authorization`. CORS preflight: **OPTIONS** on same path returns 204.

### 2.1 User

**GET** `/api/v2/users/me`

- **Query (optional):** `spaceId=<uuid>` — response may include a `token` in some environments; it is not always present.
- **Response (JSON):**
  - `userAccount`: `{ id, email, hubSpotContactId, firebaseAuthId, selectedLanguage }`
  - `serverRegion`: e.g. `"us-east-1"`
  - `token`: (optional) not always present

Use `userAccount.firebaseAuthId` as **authUserId** for the WebSocket URL.

**Guest sessions:** Guests may use a Firebase **anonymous** identity (`accounts:signUp`). `GET /api/v2/users/me?spaceId=…` still returns `userAccount` with a real `firebaseAuthId` and `id` (Gather user account UUID), but **`email` is often `null`**. Client analytics may report **`"coreRole":"Guest"`**. The guest join path in the app includes **`/app/<spaceId>/join`**. For following a member after admission, the web client uses the **`follow`** action (see §3.2); **`setFollowTarget`** is an alternate argument shape some code paths use.

### 2.2 Space

**GET** `/api/v2/spaces/:spaceId`

- **Response (JSON):** `{ "exists": true }` (or similar).

### 2.3 Space – calendar / identity (spaceUserId)

**GET** `/api/v2/spaces/:spaceId/users/me/base-calendar-events`

- **Response:** MessagePack (or JSON). Contains calendar/status data; **spaceUserId** appears in the decoded payload (e.g. under `spaceUserId` or in nested objects). Required for in-space WebSocket actions (e.g. move, setCustomStatus, broadcastEmote).

**Guest approval gate:** Before an inviter approves the pending guest in the client, this call may fail or omit `spaceUserId`. After approval, polling this endpoint (or repeating the request) is a practical way to detect that the guest may call `enterSpace`. The game WebSocket is usually already open by then: the client has sent **`loadSpaceUser`**, then **`createGuestPass`** (see §3.2) to notify the chosen host, and only later **`enterSpace`** once admitted.

**POST** `/api/v2/spaces/:spaceId/users/me/base-calendar-events/sync`

- **Request/Response:** (exact body not fully documented here.)

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

### 2.8 Other endpoints

- **POST** `/api/v2/integrations/cloudflare/siteverify` — body includes `cf_token`; response `{ "success": true }`.
- **POST** `/api/v2/releases/browser/Chrome/<version>/latest` — client/version check; response `{ "broken": false, "outdated": false }`.
- **POST** `/api/v2/newrelic/custom-events` — analytics.

### 2.9 Guest join page (HTML priming; dj + browser)

Not a JSON API: the web app serves **`GET`** the join document at:

`https://app.v2.gather.town/app/<spaceId>/join`

The CLI may request that URL with extra query parameters to match browser guest invites:

- **`guest`:** `true`
- **`copysource`:** e.g. `inviteTeamModal`
- **`copierid`:** **space user id** of the member to associate with the invite (same id used later as **`hostId`** in **`createGuestPass`** on the game WebSocket).

**Request headers (typical):** `Authorization: Bearer <JWT>`, `Origin: https://app.v2.gather.town`, `Referer: https://app.v2.gather.town/`. Response is HTML; purpose is session / edge priming before opening the game WebSocket.

---

## 3. WebSocket (game-router.v2.gather.town)

**URL:** `wss://game-router.v2.gather.town/gather-game-v2?spaceId=<uuid>&authUserId=<firebaseAuthId>`

- **spaceId:** UUID of the space.
- **authUserId:** `userAccount.firebaseAuthId` from `GET /api/v2/users/me`.

Frames are **MessagePack**-encoded. Typical control sequence: **Authenticate** → **ConnectToSpace** → **Subscribe** → (after first server message) **loadSpaceUser** → … → **enterSpace** → in-space **Action** messages.

**Member (office) flow:** **loadSpaceUser** → **enterSpace** → status, move, emotes, etc.

**Guest flow:** The game WebSocket URL uses **only** **`spaceId`** and **`authUserId`** (no `guest` / `copierid` on the socket in the captured browser flow). Those query parameters belong on the **HTML join page** (§2.9) for priming; adding them to the game-router URL has been observed to yield **`DeltaState`** frames with **empty `patches`**, so the guest **`Connection`** row never appears. The client waits for **two** **`FullStateChunk`** frames after **Subscribe** before **loadSpaceUser** (empty `invitationId`). Then: read **`Connection.spaceUserId`** from **`DeltaState`** / **`FullStateChunk`** patches (or nested decoded state) → **updateName** → **createGuestPass** with **`hostId`** = the member’s **`spaceUserId`** to notify → wait for admission → **enterSpace** → **follow** with `{ "followTargetId": "<hostSpaceUserId>" }` → … → **stopSpeaking** (if speaking) → close socket with code **`14239`** (see §3.4).

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

`connectionData.data` may be an empty buffer or `{}` when encoded; treat both as empty.

**Subscribe**

```json
{ "type": "Subscribe" }
```

**Heartbeat**

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

**loadSpaceUser** — required before **enterSpace** (and before reading **`Connection`** for guests).

- **args:** `["SpaceUser", null, { "connectionTarget": "OfficeView", "invitationId": { "type": 4, "data": {} }, "spawnAreaId": { "type": 4, "data": {} } }]`

**enterSpace** — required before setCustomStatus / move / broadcastEmote.

- **args:** `["SpaceUser", "<spaceUserId>"]`

**updateName** — set the guest’s display name (optional; often before or after **createGuestPass**).

- **args:** `["SpaceUser", "<spaceUserId>", { "name": "<string>" }]`

**startSpeaking** — mic / speaking indicator on the avatar.

- **args:** `["SpaceUser", "<spaceUserId>"]`

**stopSpeaking** — clear speaking state (e.g. before leaving the office).

- **args:** `["SpaceUser", "<spaceUserId>"]`

**setCustomStatus** — custom status line + emoji (e.g. “Now playing”).

- **args:** `["SpaceUser", "<spaceUserId>", { "text": "<string>", "clearCondition": { "type": "Never" }, "emoji": "<emoji>" }]`

**clearCustomStatus**

- **args:** `["SpaceUser", "<spaceUserId>"]`

**move**

- **args:** `["SpaceUser", "<spaceUserId>", { "direction": "Up" | "Down" | "Left" | "Right" }]`

**walk**

- **args:** `["SpaceUser", "<spaceUserId>"]`

**broadcastEmote** — in-space “reaction” (e.g. party emoji).

- **args:** `["SpaceUser", "<spaceUserId>", { "emote": "<emoji>", "count": 1, "ambientlyConnectedUserIds": ["<spaceUserId>"] }]`

**broadcastTransientTyping** — nearby chat typing indicator.

- **args:** `["SpaceUser", "<spaceUserId>", { "isTyping": true | false, "ambientlyConnectedUserIds": ["<spaceUserId>"] }]`

**broadcastMessage** — nearby chat message to ambiently connected users.

- **args:** `["SpaceUser", "<spaceUserId>", { "message": { "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "<message>" }] }] }, "ambientlyConnectedUserIds": ["<spaceUserId>"] }]`

**faceDirection**

- **args:** `["SpaceUser", "<spaceUserId>", "<direction>"]`
- **direction:** e.g. `"Up"`.

**drive**

- **args:** `["SpaceUser", "<spaceUserId>"]`

**clearCalendarInferredStatus**

- **args:** `["SpaceUser", "<spaceUserId>"]`

**updateTargetMeetingArea**

- **args:** `["SpaceUser", "<spaceUserId>", {}]`

**setFollowTarget** — alternate shape: target id as a plain third string (some clients use **follow** with `{ followTargetId }` instead).

- **args:** `["SpaceUser", "<guestSpaceUserId>", "<targetSpaceUserId>"]`

**follow** — preferred when following another player from the guest admission flow.

- **args:** `["SpaceUser", "<guestSpaceUserId>", { "followTargetId": "<targetSpaceUserId>" }]`

**createGuestPass** — notifies the selected host to admit the guest.

- **args:** `["GuestPass", null, { "hostId": "<hostSpaceUserId>" }]`

**createMemberGeneralInvite**

- **args:** `["SpaceInvitation", null]`

**getAuthenticationData**

- **args:** `["SpotifyOAuthUserSecret", null]`

### 3.3 Server → Client

Server sends MessagePack frames. Common frame types include:

- **SpaceStatus** — e.g. `warmInGatewayServer`, `warmInLogicServer`.
- **FullStateChunk** — large snapshot; **`fullStatePatches`**: array of patches (same patch shape as below).
- **DeltaState** — incremental updates; **`patches`**: array of patch objects.
- **Heartbeat** — keepalive (client and server both send).
- **ActionReturns** / **actionReturns** — correlates to client `txnId` and returns results or errors.
- **error** — error message in the same frame when present.

**Patch shape:** Each patch is typically `{ "op": "addmodel" | "replace" | …, "model": "<ModelName>", "data": { … } }`. For guest admission, look for **`model`: `"Connection"`** on **`op`: `"addmodel"`**:

- **`data.id`** — connection row id (UUID).
- **`data.spaceId`**, **`data.authUserId`**, **`data.spaceUserId`** — tie the Firebase user to the in-space user; the guest client uses **`authUserId`** (must match the socket URL) to find its own **`spaceUserId`** before sending **createGuestPass**.
- **`data.entered`** — boolean; **`false`** while still in lobby / pending admission.
- **`data.target`** — e.g. `"Default"`.

After **createGuestPass**, the server may emit patches adding a **`GuestPass`** model.

Exact response schemas are not fully enumerated here; implementers should log and handle `actionReturns` and `error` per action.

### 3.4 Client disconnect (leave office)

The web client closes the game WebSocket with **close code `14239`** and an **empty close reason** when leaving the office. RFC 6455 allows **4000–4999** for application-defined codes; this value is Gather-specific (“leave office” / teardown). Optionally send **stopSpeaking** immediately before closing if the client had started speaking.

---

## 4. Identifiers

| ID            | Source | Use |
|---------------|--------|-----|
| **spaceId**   | App URL path (e.g. `/app/<slug>-<uuid>`), or stored after login | REST paths, WebSocket URL, ConnectToSpace |
| **authUserId** | `GET /api/v2/users/me` → `userAccount.firebaseAuthId` | WebSocket URL query |
| **spaceUserId** | `GET /api/v2/spaces/:spaceId/users/me/base-calendar-events` (decode msgpack, find `spaceUserId`) **or** **`Connection`** patch on the game WebSocket after **loadSpaceUser** | All in-space WebSocket actions (move, setCustomStatus, broadcastEmote, **createGuestPass** target field **`hostId`**, etc.) |
| **hostId** (createGuestPass) | Same as the member’s **`spaceUserId`** — the person notified to admit the guest | **`createGuestPass`** action only |

No documented REST endpoint returns a list of the user’s spaces; the space ID is taken from the app URL or from the login flow (e.g. redirect or user input).

---

## 5. Content types

- **REST:** JSON for most request/response bodies. Some endpoints (e.g. base-calendar-events, chat, gather-ai) return **MessagePack**; `Content-Type` may include `application/x.gather.msgpack` or similar.
- **WebSocket:** All frames are **MessagePack** (binary).

---

## 6. Voice

This section specifies the WebSocket endpoints and message shapes used for in-space presence and voice SFU signaling.

### 6.1 Game websocket (presence / in-space)

- **WebSocket URL:** `wss://game-router.v2.gather.town/gather-game-v2?spaceId=<spaceId>&authUserId=<authUserId>` (see **§3** for control messages, actions, and server **FullStateChunk** / **DeltaState** frames).

### 6.2 Voice SFU discovery + mediasoup signaling (Socket.IO over WebSocket)

Voice SFU discovery and mediasoup signaling uses Socket.IO (Engine.IO v4) over WebSocket.

#### 6.2.1 Discover an SFU address (router Socket.IO)

- **WebSocket URL (typical):** `wss://router.v2.gather.town/socket.io/?EIO=4&transport=websocket`
- **Request** (`get-addr`):

```json
420["get-addr",{"srcId":"<uuid>","srcStreamId":"<spaceId>"}]
```

- **Response** (`addrs` with `sfuAddr`):

```json
42["addrs",{"srcId":"<uuid>","sfuAddr":"wss://sfu-v2.<region>.prod.aws.gather.town:443/<host>","distance":<number>}]
```

#### 6.2.2 Connect to the SFU Socket.IO endpoint

- **WebSocket URL (typical):** `wss://sfu-v2.<region>.prod.aws.gather.town/<host>/socket.io/?sessionId=<uuid>&EIO=4&transport=websocket`

#### 6.2.3 Mediasoup signaling events

- **Request** (`get-rtp-capabilities`):

```json
420["get-rtp-capabilities",{"wsSequenceNumber":1}]
```

- **Request** (`transport-create`, send direction):

```json
421["transport-create",{"wsSequenceNumber":2,"zodData":{"direction":"send","iceTransportRequestOptions":{"forceTurn":false,"trafficAccelerator":"GlobalAccelerator"}}}]
```

- **Request** (`transport-connect`, DTLS parameters):

```json
422["transport-connect",{"wsSequenceNumber":3,"zodData":{"transportId":"<transportId>","dtlsParameters":{"role":"client","fingerprints":[...]}}}]
```

- **Request** (`produce`, audio):

```json
423["produce",{"wsSequenceNumber":4,"zodData":{"transportId":"<transportId>","tag":"audio","kind":"audio","rtpParameters":{...}}}]
```

---

## 7. CLI (`gather-cli`)

Subcommands (see `src/index.ts`); all use **v2** hosts unless noted.

| Command | Purpose | Protocols / APIs used |
|--------|---------|----------------------|
| **login** | Interactive Google OAuth; writes `~/.config/gather/auth.json` (refresh token, space id, ids). **Argument:** space UUID or full Gather app URL. | Google OAuth, Gather `POST /api/v2/auth/google/token`, Firebase Identity Toolkit + secure token refresh, `GET /api/v2/users/me`, `GET …/base-calendar-events` |
| **music** | Poll Apple Music; update Gather custom status on an interval. | REST + game WS: **setCustomStatus** / **clearCustomStatus** |
| **lyrics** | Post timed lyrics to nearby chat. | Game WS: **broadcastTransientTyping**, **broadcastMessage** |
| **dance** | Random movement and party emote. | Game WS: **move**, **broadcastEmote**, etc. |
| **spin** | Spin in place (face direction + emote). | Game WS: **faceDirection**, **broadcastEmote** |
| **dj** | Anonymous guest session: prime join URL, game WS **loadSpaceUser** + **createGuestPass**(**hostId** = logged-in member’s **spaceUserId** from auth), wait for approval, **enterSpace**, **follow**, **getAuthenticationData** (guest2.har); SFU Socket.IO + mediasoup send audio. **startSpeaking** / **stopSpeaking** are optional UI-only; not required for SFU audio. On exit: WS close **14239**. | `GET` join page (§2.9), Firebase anonymous sign-up, `GET /users/me`, game WebSocket guest flow (§3), **router** + **sfu-v2** Socket.IO (§6.2) |

**Environment / debugging:** `DEBUG=1` enables verbose logs; `DRY=1` skips sending on some WebSocket helpers.
