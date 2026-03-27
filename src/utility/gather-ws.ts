import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { encode, decode, ExtData } from "@msgpack/msgpack";
import type { GatherCredentials } from "./auth.js";
import { getValidJwt } from "./auth.js";
import { GATHER_APP_ORIGIN, GATHER_WS_URL } from "./config.js";
import { debug, DEBUG } from "./debug.js";
import { fetchMe } from "./gather-api.js";

const DRY_RUN = process.env.DRY === "1";

/** Reuse empty payload for Gather extension type 4 (msgpack ext, not a map — see guest2.har). */
const EXT4_EMPTY = new Uint8Array(0);

function ext4(data: Uint8Array = EXT4_EMPTY): ExtData {
  return new ExtData(4, data);
}

/** Handshake headers from guest2.har (Origin + Chrome UA on the game-router socket). */
const GAME_WS_HEADERS = {
  Origin: GATHER_APP_ORIGIN,
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
};

/**
 * Browser closes the game WebSocket with this code when leaving the office (guest2.har).
 * Not a standard RFC 6455 code; Gather uses the 4000–4999 private-use range.
 */
export const GATHER_GAME_WS_CLOSE_LEAVE_OFFICE = 14239;

/** Shorten long IDs for readable command logs. */
function shortId(id: string, max = 8): string {
  return id.length > max ? id.slice(0, max) + "…" : id;
}

/** Print a WS command in the form name(arg1, arg2, ...). Used by send* helpers. */
export function printWsCommand(name: string, ...args: unknown[]): void {
  const parts = args.map((a) =>
    typeof a === "string" && a.length > 12 ? shortId(a) : JSON.stringify(a)
  );
  console.log(`${name}(${parts.join(", ")})`);
}

function sendEncoded(ws: WebSocket, payload: unknown): void {
  if (DRY_RUN) {
    const kind =
      payload && typeof payload === "object" && "type" in (payload as Record<string, unknown>)
        ? String((payload as Record<string, unknown>).type)
        : "unknown";
    debug("ws: DRY=1 skipping send", kind);
    return;
  }
  ws.send(encode(payload));
}

export function buildWsUrl(spaceId: string, authUserId: string): string {
  const u = new URL(GATHER_WS_URL);
  u.searchParams.set("spaceId", spaceId);
  u.searchParams.set("authUserId", authUserId);
  return u.toString();
}

/** HAR: key is "credential" (singular), not "credentials". */
export function sendAuthenticate(ws: WebSocket, jwt: string): void {
  sendEncoded(ws, { type: "Authenticate", credential: { type: "JWT", jwt } });
}

/** guest2.har: client `Heartbeat` uses `sequenceNumber` as extension type 4 (empty). */
export function sendClientHeartbeat(ws: WebSocket): void {
  sendEncoded(ws, {
    type: "Heartbeat",
    timestamp: Date.now(),
    sequenceNumber: ext4(),
    origin: "Client",
  });
}

/** HAR: `connectionData` is msgpack extension type 4 with empty payload (`ExtData`), not `{ type, data }` as a map. */
export function connectAndSubscribe(ws: WebSocket, jwt: string, spaceId: string): void {
  debug("ws: sending Authenticate (JWT length:", jwt.length, ")");
  sendAuthenticate(ws, jwt);
  debug("ws: sending ConnectToSpace", spaceId.slice(0, 8) + "...");
  sendEncoded(ws, {
    type: "ConnectToSpace",
    spaceId,
    connectionData: ext4(),
  });
  debug("ws: sending Subscribe");
  sendEncoded(ws, { type: "Subscribe" });
}

/** HAR: browser sends loadSpaceUser then enterSpace before setCustomStatus. */
export function sendLoadSpaceUser(ws: WebSocket): void {
  const txnId = randomUUID();
  sendEncoded(ws, {
    type: "Action",
    txnId,
    action: "loadSpaceUser",
    args: [
      "SpaceUser",
      null,
      {
        connectionTarget: "OfficeView",
        invitationId: ext4(),
        spawnAreaId: ext4(),
      },
    ],
  });
  debug("ws: sent loadSpaceUser");
}

const UUID_DASHED =
  /^([a-f0-9]{8})-([a-f0-9]{4})-([a-f0-9]{4})-([a-f0-9]{4})-([a-f0-9]{12})$/i;

function invitationIdDataBytes(copierId: string): Uint8Array {
  const t = copierId.trim();
  const m = t.match(UUID_DASHED);
  if (!m) return new TextEncoder().encode(t);
  const hex = m.slice(1).join("");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Guest-oriented `loadSpaceUser` with non-empty `invitationId.data` (not in guest.har — that file has no WS).
 */
export function sendLoadSpaceUserAsGuest(ws: WebSocket, copierSpaceUserId: string): void {
  const txnId = randomUUID();
  const inviterBytes = invitationIdDataBytes(copierSpaceUserId);
  sendEncoded(ws, {
    type: "Action",
    txnId,
    action: "loadSpaceUser",
    args: [
      "SpaceUser",
      null,
      {
        connectionTarget: "OfficeView",
        invitationId: ext4(inviterBytes),
        spawnAreaId: ext4(),
      },
    ],
  });
  debug("ws: sent loadSpaceUser (guest variant)", copierSpaceUserId.slice(0, 8) + "…");
}

/** Guest join: set display name before `createGuestPass` (browser order). */
export function sendUpdateName(ws: WebSocket, spaceUserId: string, name: string): void {
  const txnId = randomUUID();
  sendEncoded(ws, {
    type: "Action",
    txnId,
    action: "updateName",
    args: ["SpaceUser", spaceUserId, { name }],
  });
  printWsCommand("updateName", spaceUserId, name);
  debug("ws: sent updateName", name);
}

/**
 * Notifies the chosen host (member) to admit the guest.
 * Sent after `loadSpaceUser` + `updateName` once the guest's `spaceUserId` appears on the `Connection` model.
 */
export function sendCreateGuestPass(ws: WebSocket, hostSpaceUserId: string): void {
  const txnId = randomUUID();
  sendEncoded(ws, {
    type: "Action",
    txnId,
    action: "createGuestPass",
    args: ["GuestPass", null, { hostId: hostSpaceUserId }],
  });
  printWsCommand("createGuestPass", hostSpaceUserId);
  debug("ws: sent createGuestPass", hostSpaceUserId.slice(0, 8) + "…");
}

/**
 * Follow a player (guest2.har). Browser uses action `follow` and `{ followTargetId }`, not `setFollowTarget`.
 */
export function sendFollow(ws: WebSocket, selfSpaceUserId: string, followTargetSpaceUserId: string): void {
  const txnId = randomUUID();
  sendEncoded(ws, {
    type: "Action",
    txnId,
    action: "follow",
    args: ["SpaceUser", selfSpaceUserId, { followTargetId: followTargetSpaceUserId }],
  });
  printWsCommand("follow", selfSpaceUserId, followTargetSpaceUserId);
  debug("ws: sent follow", followTargetSpaceUserId.slice(0, 8) + "…");
}

/**
 * guest2.har: immediately after `follow`, before voice. Completes client bootstrap; omitting it
 * can leave the host UI stuck on “allowing” while media still works.
 */
export function sendGetAuthenticationDataSpotify(ws: WebSocket): void {
  const txnId = randomUUID();
  sendEncoded(ws, {
    type: "Action",
    txnId,
    action: "getAuthenticationData",
    args: ["SpotifyOAuthUserSecret", null],
  });
  printWsCommand("getAuthenticationData", "SpotifyOAuthUserSecret", null);
  debug("ws: sent getAuthenticationData (guest2.har order)");
}

/** Follow another person's avatar (Game API name: setFollowTarget). */
export function sendSetFollowTarget(
  ws: WebSocket,
  selfSpaceUserId: string,
  followTargetSpaceUserId: string
): string {
  const txnId = randomUUID();
  const args = ["SpaceUser", selfSpaceUserId, followTargetSpaceUserId];
  printWsCommand("setFollowTarget", selfSpaceUserId, followTargetSpaceUserId);
  debug("send setFollowTarget", { txnId: txnId.slice(0, 8) });
  sendEncoded(ws, { type: "Action", txnId, action: "setFollowTarget", args });
  return txnId;
}

/** HAR: enterSpace with args ["SpaceUser", spaceUserId] – required before setCustomStatus. */
export function sendEnterSpace(ws: WebSocket, spaceUserId: string): void {
  const txnId = randomUUID();
  sendEncoded(ws, {
    type: "Action",
    txnId,
    action: "enterSpace",
    args: ["SpaceUser", spaceUserId],
  });
  debug("ws: sent enterSpace");
}

/** setCustomStatus args from HAR: ["SpaceUser", spaceUserId, payload] */
export function sendSetCustomStatus(
  ws: WebSocket,
  spaceUserId: string,
  text: string,
  emoji: string
): string {
  const txnId = randomUUID();
  const args = [
    "SpaceUser",
    spaceUserId,
    { text, clearCondition: { type: "Never" }, emoji },
  ];
  printWsCommand("status", spaceUserId, text, emoji);
  debug("send setCustomStatus", { text, emoji, txnId: txnId.slice(0, 8) });
  sendEncoded(ws, { type: "Action", txnId, action: "setCustomStatus", args });
  return txnId;
}

/** clearCustomStatus from HAR: args ["SpaceUser", spaceUserId] */
export function sendClearStatus(ws: WebSocket, spaceUserId: string): string {
  const txnId = randomUUID();
  const args = ["SpaceUser", spaceUserId];
  printWsCommand("clearStatus", spaceUserId);
  debug("send clearCustomStatus", { txnId: txnId.slice(0, 8) });
  sendEncoded(ws, { type: "Action", txnId, action: "clearCustomStatus", args });
  return txnId;
}

/** Direction strings (dance.har): move and faceDirection use these. */
export const FACE_DIRECTIONS = ["Up", "Right", "Down", "Left"] as const;
const MOVE_DIRECTIONS = FACE_DIRECTIONS;

/** faceDirection (dance.har): args ["SpaceUser", spaceUserId, direction]. */
export function sendFaceDirection(
  ws: WebSocket,
  spaceUserId: string,
  direction: (typeof FACE_DIRECTIONS)[number]
): string {
  const txnId = randomUUID();
  const args = ["SpaceUser", spaceUserId, direction];
  printWsCommand("faceDirection", spaceUserId, direction);
  debug("send faceDirection", { direction, txnId: txnId.slice(0, 8) });
  sendEncoded(ws, { type: "Action", txnId, action: "faceDirection", args });
  return txnId;
}

/** Move action (dance.har): direction "Up" | "Down" | "Left" | "Right". */
export function sendMove(
  ws: WebSocket,
  spaceUserId: string,
  dir: number
): string {
  const txnId = randomUUID();
  const direction = MOVE_DIRECTIONS[dir % MOVE_DIRECTIONS.length];
  const args = ["SpaceUser", spaceUserId, { direction }];
  printWsCommand("move", spaceUserId, direction);
  debug("send move", { direction, txnId: txnId.slice(0, 8) });
  sendEncoded(ws, { type: "Action", txnId, action: "move", args });
  return txnId;
}

/** **`teleport`** (`poof.har`): instant move to map tile — args `["SpaceUser", id, { x, y, direction }]`. */
export function sendTeleport(
  ws: WebSocket,
  spaceUserId: string,
  x: number,
  y: number,
  direction: (typeof FACE_DIRECTIONS)[number] = "Down"
): string {
  const txnId = randomUUID();
  const args = ["SpaceUser", spaceUserId, { x, y, direction }];
  printWsCommand("teleport", spaceUserId, x, y, direction);
  debug("ws: sent teleport", { x, y, direction, txnId: txnId.slice(0, 8) });
  sendEncoded(ws, { type: "Action", txnId, action: "teleport", args });
  return txnId;
}

/** Drive action (dance.har): args ["SpaceUser", spaceUserId]. */
export function sendDrive(ws: WebSocket, spaceUserId: string): string {
  const txnId = randomUUID();
  const args = ["SpaceUser", spaceUserId];
  printWsCommand("drive", spaceUserId);
  debug("send drive", { txnId: txnId.slice(0, 8) });
  sendEncoded(ws, { type: "Action", txnId, action: "drive", args });
  return txnId;
}

/** Reaction / emote (dance.har): broadcastEmote with emote, count: 1, ambientlyConnectedUserIds. */
export function sendBroadcastEmote(
  ws: WebSocket,
  spaceUserId: string,
  emote: string
): string {
  const txnId = randomUUID();
  const args = [
    "SpaceUser",
    spaceUserId,
    { emote, count: 1, ambientlyConnectedUserIds: [spaceUserId] },
  ];
  printWsCommand("emote", spaceUserId, emote);
  debug("send broadcastEmote", { emote, txnId: txnId.slice(0, 8) });
  sendEncoded(ws, { type: "Action", txnId, action: "broadcastEmote", args });
  return txnId;
}

/** Nearby chat typing (chat.har): broadcastTransientTyping with isTyping + ambient list. */
export function sendBroadcastTransientTyping(
  ws: WebSocket,
  spaceUserId: string,
  isTyping: boolean
): string {
  const txnId = randomUUID();
  const args = [
    "SpaceUser",
    spaceUserId,
    { isTyping, ambientlyConnectedUserIds: [spaceUserId] },
  ];
  printWsCommand("typing", spaceUserId, isTyping);
  debug("send broadcastTransientTyping", { isTyping, txnId: txnId.slice(0, 8) });
  sendEncoded(ws, { type: "Action", txnId, action: "broadcastTransientTyping", args });
  return txnId;
}

/** Nearby chat message (chat.har): broadcastMessage with ProseMirror doc payload. */
export function sendBroadcastMessage(
  ws: WebSocket,
  spaceUserId: string,
  text: string,
  ambientlyConnectedUserIds?: string[]
): string {
  const txnId = randomUUID();
  const safeText = text.trim();
  const ambient = Array.isArray(ambientlyConnectedUserIds) ? ambientlyConnectedUserIds : [];
  const ambientList = ambient.length > 0 ? ambient : [spaceUserId];
  const args = [
    "SpaceUser",
    spaceUserId,
    {
      message: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: safeText }],
          },
        ],
      },
      ambientlyConnectedUserIds: ambientList,
    },
  ];
  printWsCommand("nearbyChat", spaceUserId, safeText);
  debug("send broadcastMessage", {
    text: safeText.slice(0, 80),
    recipients: ambientList.length,
    txnId: txnId.slice(0, 8),
  });
  sendEncoded(ws, { type: "Action", txnId, action: "broadcastMessage", args });
  return txnId;
}

/** Speaking state (dj.har): startSpeaking args ["SpaceUser", spaceUserId]. */
export function sendStartSpeaking(ws: WebSocket, spaceUserId: string): string {
  const txnId = randomUUID();
  const args = ["SpaceUser", spaceUserId];
  printWsCommand("startSpeaking", spaceUserId);
  debug("send startSpeaking", { txnId: txnId.slice(0, 8) });
  sendEncoded(ws, { type: "Action", txnId, action: "startSpeaking", args });
  return txnId;
}

/** Speaking state (dj.har): stopSpeaking args ["SpaceUser", spaceUserId]. */
export function sendStopSpeaking(ws: WebSocket, spaceUserId: string): string {
  const txnId = randomUUID();
  const args = ["SpaceUser", spaceUserId];
  printWsCommand("stopSpeaking", spaceUserId);
  debug("send stopSpeaking", { txnId: txnId.slice(0, 8) });
  sendEncoded(ws, { type: "Action", txnId, action: "stopSpeaking", args });
  return txnId;
}

const WAIT_FOR_FIRST_MSG_MS = 10000;
/** Browser sends `loadSpaceUser` only after two `FullStateChunk` frames (not right after `SpaceStatus`). */
const FULL_STATE_CHUNKS_BEFORE_GUEST_LOAD = 2;
const WAIT_FOR_GUEST_FULL_STATE_MS = 60_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Walk decoded msgpack for `Connection`-shaped objects (Gather sometimes nests differently than flat `patches`).
 */
function deepFindGuestConnectionSpaceUserId(obj: unknown, authUserId: string, depth = 0): string | null {
  if (depth > 35 || obj === null || obj === undefined) return null;
  const want = String(authUserId).trim();
  if (typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const x of obj) {
      const f = deepFindGuestConnectionSpaceUserId(x, authUserId, depth + 1);
      if (f) return f;
    }
    return null;
  }
  const o = obj as Record<string, unknown>;
  const got =
    o.authUserId != null && typeof o.authUserId !== "object"
      ? String(o.authUserId).trim()
      : "";
  const su = typeof o.spaceUserId === "string" ? o.spaceUserId.trim() : "";
  if (
    got === want &&
    su &&
    UUID_RE.test(su) &&
    typeof o.spaceId === "string" &&
    UUID_RE.test(String(o.spaceId).trim())
  ) {
    return su;
  }
  for (const v of Object.values(o)) {
    const f = deepFindGuestConnectionSpaceUserId(v, authUserId, depth + 1);
    if (f) return f;
  }
  return null;
}

/** Parse game-router msgpack messages for our Connection row (after loadSpaceUser, `entered` may still be false). */
export function extractOwnSpaceUserIdFromGameMessage(
  msg: unknown,
  authUserId: string
): string | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  const patches =
    m.type === "FullStateChunk" && Array.isArray(m.fullStatePatches)
      ? m.fullStatePatches
      : m.type === "DeltaState" && Array.isArray(m.patches)
        ? m.patches
        : null;
  const want = String(authUserId).trim();
  if (patches) {
    for (const p of patches) {
      if (!p || typeof p !== "object") continue;
      const patch = p as { op?: unknown; model?: unknown; data?: unknown };
      const op = typeof patch.op === "string" ? patch.op.toLowerCase() : "";
      if (patch.model !== "Connection" || op !== "addmodel") continue;
      if (!patch.data || typeof patch.data !== "object") continue;
      const d = patch.data as { authUserId?: unknown; spaceUserId?: unknown };
      const got =
        d.authUserId != null && typeof d.authUserId !== "object"
          ? String(d.authUserId).trim()
          : "";
      if (got === want && typeof d.spaceUserId === "string" && d.spaceUserId.trim()) {
        return d.spaceUserId.trim();
      }
    }
  }
  return deepFindGuestConnectionSpaceUserId(msg, authUserId);
}

function patchesFromGameMessage(msg: unknown): unknown[] | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  if (m.type === "FullStateChunk" && Array.isArray(m.fullStatePatches)) return m.fullStatePatches;
  if (m.type === "DeltaState" && Array.isArray(m.patches)) return m.patches;
  return null;
}

/**
 * Decode Gather **SpaceUser** grid `position` values: msgpack **ext** wrapping `{ k: "Position", v: { x, y } }` (`voice.har`),
 * or plain `{ x, y }` / that tagged object after decode.
 */
export function decodeGatherGridPosition(value: unknown): { x: number; y: number } | null {
  if (value === null || value === undefined) return null;

  if (value instanceof ExtData) {
    try {
      const bytes = typeof value.data === "function" ? value.data(0) : value.data;
      return decodeGatherGridPosition(decode(bytes));
    } catch {
      return null;
    }
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if (typeof o.x === "number" && typeof o.y === "number" && Number.isFinite(o.x) && Number.isFinite(o.y)) {
      /** `Math.floor` matches map tile occupancy for fractional **SpaceUser** coords (Gather grid). */
      return { x: Math.floor(o.x), y: Math.floor(o.y) };
    }
    if (o.k === "Position" && o.v !== null && typeof o.v === "object" && !Array.isArray(o.v)) {
      const v = o.v as Record<string, unknown>;
      if (typeof v.x === "number" && typeof v.y === "number" && Number.isFinite(v.x) && Number.isFinite(v.y)) {
        return { x: Math.floor(v.x), y: Math.floor(v.y) };
      }
    }
    const t = o.type;
    const raw = o.data;
    if (typeof t === "number" && raw != null && typeof raw === "object" && "byteLength" in raw) {
      try {
        const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBufferLike);
        return decodeGatherGridPosition(decode(u8));
      } catch {
        return null;
      }
    }
  }

  return null;
}

function patchModelIsSpaceUser(model: unknown): boolean {
  return model === "SpaceUser" || (typeof model === "string" && /^spaceuser$/i.test(model.trim()));
}

/**
 * Merge **SpaceUser** tile positions from **FullStateChunk** / **DeltaState** (`addmodel` snapshots; **`replace`** sends new coords — path shape varies, so any decodable **Position** payload on that row updates the tile).
 */
export function mergeSpaceUserGridPositionsFromGameMessage(
  msg: unknown,
  into: Map<string, { x: number; y: number }>
): void {
  const patches = patchesFromGameMessage(msg);
  if (!patches) return;

  for (const p of patches) {
    if (!p || typeof p !== "object") continue;
    const patch = p as Record<string, unknown>;
    if (!patchModelIsSpaceUser(patch.model)) continue;
    const op = typeof patch.op === "string" ? patch.op.toLowerCase() : "";

    if (op === "addmodel" && patch.data !== null && typeof patch.data === "object" && !Array.isArray(patch.data)) {
      const d = patch.data as { id?: unknown; position?: unknown };
      const id = typeof d.id === "string" && UUID_RE.test(d.id.trim()) ? d.id.trim() : null;
      if (!id) continue;
      const pos = decodeGatherGridPosition(d.position);
      if (pos) into.set(id, pos);
      continue;
    }

    if (op === "replace" && typeof patch.id === "string" && UUID_RE.test(patch.id.trim())) {
      const pos = decodeGatherGridPosition(patch.data);
      if (pos) into.set(patch.id.trim(), pos);
    }
  }
}

/** Empty msgpack **ext** or missing link → no parent UUID (`MapArea.parentAreaId`, etc.). */
function gatherNullableUuidRef(value: unknown): string | null {
  if (typeof value === "string") {
    const t = value.trim();
    return UUID_RE.test(t) ? t : null;
  }
  if (value instanceof ExtData) return null;
  return null;
}

/**
 * Decode **`dimensionsInTiles`** on **MapArea** (`voice.har`: `{ k: "Dimensions", v: { width, height } }` inside ext).
 */
export function decodeGatherDimensions(value: unknown): { width: number; height: number } | null {
  if (value === null || value === undefined) return null;

  if (value instanceof ExtData) {
    try {
      const bytes = typeof value.data === "function" ? value.data(0) : value.data;
      return decodeGatherDimensions(decode(bytes));
    } catch {
      return null;
    }
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    if (typeof o.width === "number" && typeof o.height === "number" && Number.isFinite(o.width) && Number.isFinite(o.height)) {
      return { width: Math.round(o.width), height: Math.round(o.height) };
    }
    if (o.k === "Dimensions" && o.v !== null && typeof o.v === "object" && !Array.isArray(o.v)) {
      const v = o.v as Record<string, unknown>;
      if (typeof v.width === "number" && typeof v.height === "number" && Number.isFinite(v.width) && Number.isFinite(v.height)) {
        return { width: Math.round(v.width), height: Math.round(v.height) };
      }
    }
    const t = o.type;
    const raw = o.data;
    if (typeof t === "number" && raw != null && typeof raw === "object" && "byteLength" in raw) {
      try {
        const u8 = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBufferLike);
        return decodeGatherDimensions(decode(u8));
      } catch {
        return null;
      }
    }
  }

  return null;
}

export type MapAreaLayoutEntry = {
  name: string | null;
  parentAreaId: string | null;
  relativeX: number;
  relativeY: number;
  mapId: string | null;
  width: number;
  height: number;
};

/**
 * Merge **MapArea** coworking / room tiles from **FullStateChunk** / **DeltaState** (`addmodel` only in `voice.har`).
 */
export function mergeMapAreaLayoutsFromGameMessage(
  msg: unknown,
  into: Map<string, MapAreaLayoutEntry>
): void {
  const patches = patchesFromGameMessage(msg);
  if (!patches) return;

  for (const p of patches) {
    if (!p || typeof p !== "object") continue;
    const patch = p as Record<string, unknown>;
    if (patch.model !== "MapArea") continue;
    const op = typeof patch.op === "string" ? patch.op.toLowerCase() : "";
    if (op !== "addmodel") continue;
    if (!patch.data || typeof patch.data !== "object" || Array.isArray(patch.data)) continue;
    const d = patch.data as Record<string, unknown>;
    const id = typeof d.id === "string" && UUID_RE.test(d.id.trim()) ? d.id.trim() : null;
    if (!id) continue;
    const rx = d.relativeX;
    const ry = d.relativeY;
    if (typeof rx !== "number" || typeof ry !== "number" || !Number.isFinite(rx) || !Number.isFinite(ry)) continue;
    const mapId =
      typeof d.mapId === "string" && UUID_RE.test(d.mapId.trim()) ? d.mapId.trim() : null;
    const name = typeof d.name === "string" && d.name.trim() ? d.name.trim() : null;
    const dims = decodeGatherDimensions(d.dimensionsInTiles);
    const width = dims ? Math.max(1, Math.round(dims.width)) : 1;
    const height = dims ? Math.max(1, Math.round(dims.height)) : 1;
    into.set(id, {
      name,
      parentAreaId: gatherNullableUuidRef(d.parentAreaId),
      relativeX: Math.round(rx),
      relativeY: Math.round(ry),
      mapId,
      width,
      height,
    });
  }
}

export function findMapAreaIdByCanonicalName(
  areas: Map<string, MapAreaLayoutEntry>,
  canonicalName: string
): string | null {
  const want = canonicalName.trim().toLowerCase();
  if (!want) return null;
  for (const [areaId, a] of areas) {
    if (a.name !== null && a.name.trim().toLowerCase() === want) return areaId;
  }
  return null;
}

/** Top-left world tile of a **MapArea** after summing **`relativeX` / `relativeY`** up **parentAreaId** (`voice.har`). */
export function resolveMapAreaWorldOrigin(
  areas: Map<string, MapAreaLayoutEntry>,
  areaId: string
): { x: number; y: number } | null {
  let x = 0;
  let y = 0;
  let cur: string | null = areaId;
  const seen = new Set<string>();
  while (cur) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const a = areas.get(cur);
    if (!a) return null;
    x += a.relativeX;
    y += a.relativeY;
    cur = a.parentAreaId;
  }
  return { x, y };
}

/**
 * World tile AABB for a **MapArea** by summing **`relativeX` / `relativeY`** up the **parentAreaId** chain (`voice.har` **Dance Floor**).
 */
export function resolveMapAreaWorldRect(
  areas: Map<string, MapAreaLayoutEntry>,
  areaId: string
): { mapId: string | null; minX: number; minY: number; maxX: number; maxY: number } | null {
  const leaf = areas.get(areaId);
  if (!leaf) return null;
  const origin = resolveMapAreaWorldOrigin(areas, areaId);
  if (!origin) return null;
  return {
    mapId: leaf.mapId,
    minX: origin.x,
    minY: origin.y,
    maxX: origin.x + leaf.width - 1,
    maxY: origin.y + leaf.height - 1,
  };
}

/** Gather map tiles are **32×32 px** in catalog metadata (`voice.har` **CatalogItemVariant**). */
const CATALOG_TILE_PX = 32;

export type MapObjectPlacementEntry = {
  id: string;
  /** When set, position is **root** in this **MapArea** (sum `parentAreaId` chain + `relativeX`/`Y`). */
  parentAreaId: string | null;
  /** When set (often with empty `parentAreaId`), position is **parent object** world base + `relativeX`/`Y` (`voice.har`). */
  parentObjectId: string | null;
  relativeX: number;
  relativeY: number;
  mapId: string | null;
  catalogItemVariantId: string | null;
};

/** **CatalogItemVariant** footprint for pathfinding (`collision.points` in tile space; pixel box fallback). */
export type CatalogItemVariantFootprintEntry = {
  collisionPoints: { x: number; y: number }[];
  widthPx: number | null;
  heightPx: number | null;
  originXPx: number | null;
  originYPx: number | null;
};

export function makeTileKey(x: number, y: number): string {
  return `${x},${y}`;
}

function addBlockedTilesFromCollisionPoints(
  blocked: Set<string>,
  baseX: number,
  baseY: number,
  points: { x: number; y: number }[]
): void {
  if (points.length === 0) return;
  let minWX = Infinity;
  let maxWX = -Infinity;
  let minWY = Infinity;
  let maxWY = -Infinity;
  for (const pt of points) {
    if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) continue;
    const wx = baseX + pt.x;
    const wy = baseY + pt.y;
    minWX = Math.min(minWX, wx);
    maxWX = Math.max(maxWX, wx);
    minWY = Math.min(minWY, wy);
    maxWY = Math.max(maxWY, wy);
  }
  if (!Number.isFinite(minWX)) return;
  const tx0 = Math.floor(minWX);
  const tx1 = Math.floor(maxWX);
  const ty0 = Math.floor(minWY);
  const ty1 = Math.floor(maxWY);
  for (let tx = tx0; tx <= tx1; tx++) {
    for (let ty = ty0; ty <= ty1; ty++) {
      blocked.add(makeTileKey(tx, ty));
    }
  }
}

function catalogOriginTiles(fp: CatalogItemVariantFootprintEntry): { ox: number; oy: number } {
  return {
    ox: (fp.originXPx ?? 0) / CATALOG_TILE_PX,
    oy: (fp.originYPx ?? 0) / CATALOG_TILE_PX,
  };
}

function addBlockedTilesFromPixelSprite(
  blocked: Set<string>,
  baseX: number,
  baseY: number,
  fp: CatalogItemVariantFootprintEntry
): void {
  if (fp.widthPx == null || fp.heightPx == null) return;
  const wTiles = Math.max(1, Math.ceil(fp.widthPx / CATALOG_TILE_PX));
  const hTiles = Math.max(1, Math.ceil(fp.heightPx / CATALOG_TILE_PX));
  const { ox, oy } = catalogOriginTiles(fp);
  const left = baseX - ox;
  const top = baseY - oy;
  for (let dx = 0; dx < wTiles; dx++) {
    for (let dy = 0; dy < hTiles; dy++) {
      blocked.add(makeTileKey(Math.floor(left + dx), Math.floor(top + dy)));
    }
  }
}

/**
 * **MapObject** placement in map tile space: **`parentObjectId`** chain ends at a **MapArea**-rooted object (`voice.har`).
 */
export function resolveMapObjectWorldBase(
  objects: Map<string, MapObjectPlacementEntry>,
  mapAreas: Map<string, MapAreaLayoutEntry>,
  objectId: string,
  visiting: Set<string> = new Set()
): { x: number; y: number } | null {
  if (visiting.has(objectId)) return null;
  visiting.add(objectId);
  const o = objects.get(objectId);
  if (!o) {
    visiting.delete(objectId);
    return null;
  }

  let base: { x: number; y: number } | null = null;
  if (o.parentObjectId) {
    const pw = resolveMapObjectWorldBase(objects, mapAreas, o.parentObjectId, visiting);
    if (pw) base = { x: pw.x + o.relativeX, y: pw.y + o.relativeY };
  } else if (o.parentAreaId) {
    const origin = resolveMapAreaWorldOrigin(mapAreas, o.parentAreaId);
    if (origin) base = { x: origin.x + o.relativeX, y: origin.y + o.relativeY };
  }

  visiting.delete(objectId);
  return base;
}

/**
 * Merge **CatalogItemVariant** collision / size data (`voice.har`: **desks** use **`collision.points`** covering several tiles).
 */
export function mergeCatalogItemVariantFootprintsFromGameMessage(
  msg: unknown,
  into: Map<string, CatalogItemVariantFootprintEntry>
): void {
  const patches = patchesFromGameMessage(msg);
  if (!patches) return;

  for (const p of patches) {
    if (!p || typeof p !== "object") continue;
    const patch = p as Record<string, unknown>;
    if (patch.model !== "CatalogItemVariant") continue;
    const op = typeof patch.op === "string" ? patch.op.toLowerCase() : "";
    if (op !== "addmodel") continue;
    if (!patch.data || typeof patch.data !== "object" || Array.isArray(patch.data)) continue;
    const d = patch.data as Record<string, unknown>;
    const id = typeof d.id === "string" && UUID_RE.test(d.id.trim()) ? d.id.trim() : null;
    if (!id) continue;

    const collisionPoints: { x: number; y: number }[] = [];
    const coll = d.collision;
    if (coll !== null && typeof coll === "object" && !Array.isArray(coll)) {
      const pts = (coll as { points?: unknown }).points;
      if (Array.isArray(pts)) {
        for (const pt of pts) {
          if (!pt || typeof pt !== "object" || Array.isArray(pt)) continue;
          const o = pt as Record<string, unknown>;
          if (typeof o.x === "number" && typeof o.y === "number" && Number.isFinite(o.x) && Number.isFinite(o.y)) {
            collisionPoints.push({ x: o.x, y: o.y });
          }
        }
      }
    }

    const dims = decodeGatherDimensions(d.dimensionsInPixels);
    const ox = typeof d.originX === "number" && Number.isFinite(d.originX) ? d.originX : null;
    const oy = typeof d.originY === "number" && Number.isFinite(d.originY) ? d.originY : null;

    into.set(id, {
      collisionPoints,
      widthPx: dims ? dims.width : null,
      heightPx: dims ? dims.height : null,
      originXPx: ox,
      originYPx: oy,
    });
  }
}

/**
 * Merge **MapObject** props from **FullStateChunk** / **DeltaState** (`addmodel`); used to approximate **impassable** tiles for pathfinding.
 */
export function mergeMapObjectPlacementsFromGameMessage(
  msg: unknown,
  into: Map<string, MapObjectPlacementEntry>
): void {
  const patches = patchesFromGameMessage(msg);
  if (!patches) return;

  for (const p of patches) {
    if (!p || typeof p !== "object") continue;
    const patch = p as Record<string, unknown>;
    if (patch.model !== "MapObject") continue;
    const op = typeof patch.op === "string" ? patch.op.toLowerCase() : "";
    if (op !== "addmodel") continue;
    if (!patch.data || typeof patch.data !== "object" || Array.isArray(patch.data)) continue;
    const d = patch.data as Record<string, unknown>;
    const id = typeof d.id === "string" && UUID_RE.test(d.id.trim()) ? d.id.trim() : null;
    if (!id) continue;
    const parentAreaId = gatherNullableUuidRef(d.parentAreaId);
    const parentObjectId = gatherNullableUuidRef(d.parentObjectId);
    if (!parentAreaId && !parentObjectId) continue;
    const rx = d.relativeX;
    const ry = d.relativeY;
    if (typeof rx !== "number" || typeof ry !== "number" || !Number.isFinite(rx) || !Number.isFinite(ry)) continue;
    const mapId =
      typeof d.mapId === "string" && UUID_RE.test(d.mapId.trim()) ? d.mapId.trim() : null;
    const catalogItemVariantId =
      typeof d.catalogItemVariantId === "string" && UUID_RE.test(d.catalogItemVariantId.trim())
        ? d.catalogItemVariantId.trim()
        : null;
    into.set(id, {
      id,
      parentAreaId,
      parentObjectId,
      relativeX: rx,
      relativeY: ry,
      mapId,
      catalogItemVariantId,
    });
  }
}

/**
 * World tile keys (`makeTileKey`) occupied by **MapObject** instances: **`CatalogItemVariant.collision.points`** AABB in tile space (`voice.har` **desks**),
 * else **`dimensionsInPixels` / origin** box, else a single floored anchor tile.
 * When **`onlyMapId`** is set, objects on other maps are skipped.
 */
export function collectBlockedTilesFromMapObjects(
  mapAreas: Map<string, MapAreaLayoutEntry>,
  objects: Map<string, MapObjectPlacementEntry>,
  catalogVariants: Map<string, CatalogItemVariantFootprintEntry>,
  onlyMapId: string | null
): Set<string> {
  const blocked = new Set<string>();
  for (const o of objects.values()) {
    if (onlyMapId && o.mapId && o.mapId !== onlyMapId) continue;
    const wb = resolveMapObjectWorldBase(objects, mapAreas, o.id);
    if (!wb) continue;
    const baseX = wb.x;
    const baseY = wb.y;
    const variant = o.catalogItemVariantId ? catalogVariants.get(o.catalogItemVariantId) : undefined;
    if (variant && variant.collisionPoints.length > 0) {
      const { ox, oy } = catalogOriginTiles(variant);
      addBlockedTilesFromCollisionPoints(blocked, baseX - ox, baseY - oy, variant.collisionPoints);
    } else if (
      variant &&
      variant.widthPx != null &&
      variant.heightPx != null &&
      (variant.widthPx > 0 || variant.heightPx > 0)
    ) {
      addBlockedTilesFromPixelSprite(blocked, baseX, baseY, variant);
    } else {
      blocked.add(makeTileKey(Math.floor(baseX), Math.floor(baseY)));
    }
  }
  return blocked;
}

/** Avoid following map/space ids when walking SpaceUser / Connection payloads. */
const GAME_PATCH_SKIP_RECURSE_KEYS = new Set([
  "spaceId",
  "mapId",
  "spawnToken",
  "srcStreamId",
  "srcId",
]);

/**
 * **FullStateChunk** / **DeltaState** only: depth-walk the **entire** decoded message (patches, metadata, nested maps),
 * not only each patch’s `data`, so IDs in wrapper fields aren’t missed.
 */
export function collectPeerHintsFromGameStateMessage(msg: unknown): {
  userAccountIds: string[];
  firebaseAuthIds: string[];
  spaceUserIds: string[];
  /** `SpaceUser.data.id` → `data.userAccountId` when both present (`voice.har` full snapshots). */
  spaceUserToUserAccountId: Record<string, string>;
} {
  const userAccountIds = new Set<string>();
  const firebaseAuthIds = new Set<string>();
  const spaceUserIds = new Set<string>();
  const spaceUserToUserAccountId: Record<string, string> = {};

  if (!msg || typeof msg !== "object") {
    return { userAccountIds: [], firebaseAuthIds: [], spaceUserIds: [], spaceUserToUserAccountId: {} };
  }
  const root = msg as Record<string, unknown>;
  const t = root.type;
  if (t !== "FullStateChunk" && t !== "DeltaState") {
    return { userAccountIds: [], firebaseAuthIds: [], spaceUserIds: [], spaceUserToUserAccountId: {} };
  }

  const addUa = (s: string): void => {
    const x = s.trim();
    if (UUID_RE.test(x)) userAccountIds.add(x);
  };

  const UUID_TOKEN_IN_STR = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

  const walk = (obj: unknown, depth: number): void => {
    if (depth > 28 || obj === null || obj === undefined) return;
    if (typeof obj !== "object") return;
    if (obj instanceof Map) {
      for (const v of obj.values()) walk(v, depth + 1);
      return;
    }
    if (Array.isArray(obj)) {
      for (const x of obj) {
        if (typeof x === "string") {
          const t = x.trim();
          if (UUID_RE.test(t)) spaceUserIds.add(t);
        } else {
          walk(x, depth + 1);
        }
      }
      return;
    }
    const o = obj as Record<string, unknown>;

    const isUserAccountModel =
      o.model === "UserAccount" || (typeof o.model === "string" && /^useraccount$/i.test(o.model));
    if (
      isUserAccountModel &&
      o.data !== null &&
      typeof o.data === "object" &&
      !Array.isArray(o.data)
    ) {
      /** `voice.har`: `FullStateChunk` / `DeltaState` include `addmodel` **UserAccount** rows; SFU ids match **`data.id`**. */
      const uid = (o.data as { id?: unknown }).id;
      if (typeof uid === "string") addUa(uid);
    }

    const isSpaceUserModel =
      o.model === "SpaceUser" || (typeof o.model === "string" && /^spaceuser$/i.test(o.model));
    if (isSpaceUserModel && typeof o.id === "string" && UUID_RE.test(o.id.trim())) {
      spaceUserIds.add(o.id.trim());
    }
    if (
      isSpaceUserModel &&
      o.data !== null &&
      typeof o.data === "object" &&
      !Array.isArray(o.data)
    ) {
      const d = o.data as { id?: unknown; userAccountId?: unknown; gatherUserAccountId?: unknown };
      const sid = typeof d.id === "string" && UUID_RE.test(d.id.trim()) ? d.id.trim() : null;
      if (sid) spaceUserIds.add(sid);
      if (typeof d.userAccountId === "string") addUa(d.userAccountId);
      if (typeof d.gatherUserAccountId === "string") addUa(d.gatherUserAccountId);
      const uaid =
        typeof d.userAccountId === "string" && UUID_RE.test(d.userAccountId.trim())
          ? d.userAccountId.trim()
          : typeof d.gatherUserAccountId === "string" && UUID_RE.test(d.gatherUserAccountId.trim())
            ? d.gatherUserAccountId.trim()
            : null;
      if (sid && uaid) spaceUserToUserAccountId[sid] = uaid;
    }

    if (typeof o.path === "string" && o.path.length > 0) {
      UUID_TOKEN_IN_STR.lastIndex = 0;
      let pm: RegExpExecArray | null;
      while ((pm = UUID_TOKEN_IN_STR.exec(o.path)) !== null) {
        spaceUserIds.add(pm[0]);
      }
    }

    const suField = o.spaceUserId;
    if (typeof suField === "string" && UUID_RE.test(suField.trim())) {
      spaceUserIds.add(suField.trim());
    }

    for (const key of ["userAccountId", "gatherUserAccountId"] as const) {
      const v = o[key];
      if (typeof v === "string") addUa(v);
    }
    const ua = o.userAccount;
    if (ua && typeof ua === "object" && !Array.isArray(ua)) {
      const id = (ua as { id?: unknown }).id;
      if (typeof id === "string") addUa(id);
    }

    const au = o.authUserId;
    if (au != null && typeof au !== "object" && typeof au !== "function") {
      const s = String(au).trim();
      if (s.length >= 10 && !UUID_RE.test(s)) firebaseAuthIds.add(s);
    }

    for (const [k, v] of Object.entries(o)) {
      if (GAME_PATCH_SKIP_RECURSE_KEYS.has(k)) continue;
      walk(v, depth + 1);
    }
  };

  walk(msg, 0);

  return {
    userAccountIds: [...userAccountIds],
    firebaseAuthIds: [...firebaseAuthIds],
    spaceUserIds: [...spaceUserIds],
    spaceUserToUserAccountId,
  };
}

export function extractUserAccountIdsFromGamePatchesMessage(msg: unknown): string[] {
  return collectPeerHintsFromGameStateMessage(msg).userAccountIds;
}

export function extractFirebaseAuthIdsFromConnectionPatches(msg: unknown): string[] {
  return collectPeerHintsFromGameStateMessage(msg).firebaseAuthIds;
}

export function extractSpaceUserIdsFromGamePatchesMessage(msg: unknown): string[] {
  return collectPeerHintsFromGameStateMessage(msg).spaceUserIds;
}

/**
 * guest2.har: `enterSpace` is sent only after `GuestPass` patch `path: "/state"` → `"Admitted"`.
 * REST `base-calendar-events` may succeed before that state is applied on this WebSocket, so `enterSpace`
 * sent too early is ignored and the avatar never appears.
 */
export function waitForGuestPassAdmitted(
  ws: WebSocket,
  guestSpaceUserId: string,
  timeoutMs = 600_000
): Promise<void> {
  const want = guestSpaceUserId.trim();
  let guestPassRowId: string | null = null;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          "Timed out waiting for guest admission (GuestPass.state=Admitted) on the game WebSocket. Approve the guest in Gather."
        )
      );
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      ws.off("close", onClose);
    };

    const ok = () => {
      cleanup();
      resolve();
    };

    const onClose = () => {
      cleanup();
      reject(new Error("Game WebSocket closed while waiting for host admission."));
    };

    const guestPassAdmittedInPatches = (patches: unknown[]): boolean => {
      for (const p of patches) {
        if (!p || typeof p !== "object") continue;
        const patch = p as { op?: unknown; model?: unknown; data?: unknown };
        if (patch.model !== "GuestPass") continue;
        const op = typeof patch.op === "string" ? patch.op.toLowerCase() : "";
        if (op !== "addmodel" || !patch.data || typeof patch.data !== "object") continue;
        const d = patch.data as { id?: unknown; spaceUserId?: unknown; state?: unknown };
        const su = typeof d.spaceUserId === "string" ? d.spaceUserId.trim() : "";
        if (su === want && typeof d.id === "string" && d.id.trim()) {
          guestPassRowId = d.id.trim();
        }
        if (su === want && d.state === "Admitted") return true;
      }
      for (const p of patches) {
        if (!p || typeof p !== "object") continue;
        const patch = p as { op?: unknown; model?: unknown; id?: unknown; path?: unknown; data?: unknown };
        if (patch.model !== "GuestPass") continue;
        const op = typeof patch.op === "string" ? patch.op.toLowerCase() : "";
        if (op !== "replace" || !guestPassRowId || patch.id !== guestPassRowId) continue;
        const path = typeof patch.path === "string" ? patch.path : "";
        if ((path === "/state" || path.endsWith("/state")) && patch.data === "Admitted") return true;
      }
      return false;
    };

    const onMessage = (data: Buffer | ArrayBuffer) => {
      try {
        const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as Buffer);
        const msg = decode(buf) as unknown;
        const patches = patchesFromGameMessage(msg);
        if (patches && guestPassAdmittedInPatches(patches)) {
          debug("ws: GuestPass Admitted — safe to enterSpace (guest2.har order)");
          ok();
        }
      } catch {
        /* ignore */
      }
    };

    ws.on("message", onMessage);
    ws.on("close", onClose);
  });
}

export type GatherConnectionOptions = {
  /** Inviter's **space user id** (same as real invite URL `copierid`, UUID). */
  copierId?: string;
};

/**
 * Guest check-in: game-router URL is **only** `spaceId` + `authUserId` (same as browser capture for this flow).
 * `guest` / `copierid` stay on the HTML `/join` priming request only; putting them on the socket produced empty
 * `DeltaState` patches in testing. Wait for two `FullStateChunk` frames, then `loadSpaceUser`, then
 * `updateName` + `createGuestPass` when `Connection` appears.
 */
export type GuestGameCheckIn = {
  ws: WebSocket;
  /** `SpaceUser.id` from the guest's `Connection` row — use for `enterSpace` / `follow` (same as guest2.har). */
  guestSpaceUserId: Promise<string>;
};

export function openGuestGameSocketForCheckIn(
  creds: GatherCredentials,
  notifyHostSpaceUserId: string,
  onClose?: (code: number, reason?: Buffer) => void
): Promise<GuestGameCheckIn> {
  return new Promise(async (resolve, reject) => {
    let resolveGuestSpaceUserId!: (id: string) => void;
    let rejectGuestSpaceUserId!: (err: Error) => void;
    const guestSpaceUserId = new Promise<string>((res, rej) => {
      resolveGuestSpaceUserId = res;
      rejectGuestSpaceUserId = rej;
    });
    let guestSpaceUserIdSettled = false;
    const settleGuestSpaceUserId = (id: string) => {
      if (guestSpaceUserIdSettled) return;
      guestSpaceUserIdSettled = true;
      resolveGuestSpaceUserId(id);
    };
    const failGuestSpaceUserId = (err: Error) => {
      if (guestSpaceUserIdSettled) return;
      guestSpaceUserIdSettled = true;
      rejectGuestSpaceUserId(err);
    };

    const jwt = await getValidJwt(creds);
    const spaceId = creds.spaceId!;
    const me = await fetchMe(jwt, spaceId);
    creds.authUserId = me.authUserId;
    if (me.spaceToken) creds.gatherSpaceSessionToken = me.spaceToken;
    const authUserId = me.authUserId;
    const guestDisplayName = process.env.GATHER_GUEST_NAME?.trim() || "DJ";
    const url = buildWsUrl(spaceId, authUserId);
    debug("ws: guest check-in (spaceId+authUserId only, like browser WS)", url.slice(0, 200) + "…");
    const socket = new WebSocket(url, { headers: GAME_WS_HEADERS });
    socket.binaryType = "arraybuffer";
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let fullStateChunkCount = 0;
    let loadSpaceUserSent = false;
    let createGuestPassSent = false;
    let settledOpen = false;
    let loggedConnectionMismatch = false;
    let recvAfterLoadSpaceUser = 0;

    const trySendLoadSpaceUser = (reason: string) => {
      if (loadSpaceUserSent) return;
      loadSpaceUserSent = true;
      clearTimeout(timeout);
      sendLoadSpaceUser(socket);
      debug("ws: loadSpaceUser sent (" + reason + ")");
      if (!settledOpen) {
        settledOpen = true;
        resolve({ ws: socket, guestSpaceUserId });
      }
    };

    const timeout = setTimeout(() => {
      if (loadSpaceUserSent) return;
      if (fullStateChunkCount >= 1) {
        trySendLoadSpaceUser("timeout fallback after " + fullStateChunkCount + " FullStateChunk(s)");
      } else {
        loadSpaceUserSent = true;
        try {
          socket.terminate();
        } catch {
          /* ignore */
        }
        failGuestSpaceUserId(
          new Error("Timed out waiting for FullStateChunk before guest loadSpaceUser (no state from server)")
        );
        reject(
          new Error(
            "Timed out waiting for FullStateChunk before guest loadSpaceUser (no state from server)"
          )
        );
      }
    }, WAIT_FOR_GUEST_FULL_STATE_MS);

    socket.on("open", () => {
      connectAndSubscribe(socket, jwt, spaceId);
      setTimeout(() => {
        if (socket.readyState === WebSocket.OPEN) sendClientHeartbeat(socket);
      }, 800);
      heartbeatTimer = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) sendClientHeartbeat(socket);
      }, 5000);
    });
    socket.on("error", (err) => {
      clearTimeout(timeout);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (!guestSpaceUserIdSettled) {
        failGuestSpaceUserId(err instanceof Error ? err : new Error(String(err)));
      }
      if (!loadSpaceUserSent) reject(err);
    });
    socket.on("close", (code, reason) => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (!guestSpaceUserIdSettled) {
        failGuestSpaceUserId(
          new Error("Game WebSocket closed before guest space user id was received (check auth / space).")
        );
      }
      debug("ws: close", code, reason?.toString() || "");
      if (code === 4030) {
        console.warn("Server closed connection (4030). Often auth/session invalid.");
      }
      onClose?.(code, reason as Buffer);
    });
    socket.on("message", (data: Buffer | ArrayBuffer) => {
      let msg: unknown = null;
      const byteLen = data instanceof ArrayBuffer ? data.byteLength : (data as Buffer).length;
      try {
        const buf =
          data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as Buffer);
        msg = decode(buf) as unknown;
      } catch (err) {
        if (DEBUG) {
          debug("ws: msgpack decode failed", byteLen, "bytes", err instanceof Error ? err.message : err);
        }
        return;
      }

      if (!loadSpaceUserSent && msg && typeof msg === "object") {
        const t = (msg as { type?: unknown }).type;
        if (t === "FullStateChunk") {
          fullStateChunkCount++;
          debug("ws: FullStateChunk", fullStateChunkCount + "/" + FULL_STATE_CHUNKS_BEFORE_GUEST_LOAD);
          if (fullStateChunkCount >= FULL_STATE_CHUNKS_BEFORE_GUEST_LOAD) {
            trySendLoadSpaceUser(FULL_STATE_CHUNKS_BEFORE_GUEST_LOAD + " FullStateChunk(s)");
          }
        }
      }

      if (DEBUG && loadSpaceUserSent && msg && typeof msg === "object") {
        recvAfterLoadSpaceUser++;
        if (recvAfterLoadSpaceUser <= 35) {
          const t = (msg as { type?: unknown }).type;
          const ps = (msg as { patches?: unknown }).patches;
          const fsp = (msg as { fullStatePatches?: unknown }).fullStatePatches;
          debug(
            "ws: recv after loadSpaceUser",
            recvAfterLoadSpaceUser,
            String(t),
            Array.isArray(ps) ? ps.length + " patches" : "",
            Array.isArray(fsp) ? fsp.length + " fullStatePatches" : ""
          );
        }
      }

      if (createGuestPassSent || socket.readyState !== WebSocket.OPEN || !loadSpaceUserSent) return;
      const ownId = extractOwnSpaceUserIdFromGameMessage(msg, authUserId);
      if (ownId) {
        createGuestPassSent = true;
        settleGuestSpaceUserId(ownId);
        sendUpdateName(socket, ownId, guestDisplayName);
        sendCreateGuestPass(socket, notifyHostSpaceUserId);
        debug("ws: guest spaceUserId", ownId.slice(0, 8) + "…", "→ updateName + createGuestPass host", notifyHostSpaceUserId.slice(0, 8) + "…");
        return;
      }
      if (
        DEBUG &&
        !loggedConnectionMismatch &&
        msg &&
        typeof msg === "object" &&
        (msg as { type?: unknown }).type === "DeltaState"
      ) {
        const patches = (msg as { patches?: unknown }).patches;
        if (Array.isArray(patches)) {
          const authIds: string[] = [];
          for (const p of patches) {
            if (!p || typeof p !== "object") continue;
            const patch = p as { op?: unknown; model?: unknown; data?: unknown };
            const op = typeof patch.op === "string" ? patch.op.toLowerCase() : "";
            if (patch.model !== "Connection" || op !== "addmodel" || !patch.data) continue;
            const d = patch.data as { authUserId?: unknown };
            if (d.authUserId != null && typeof d.authUserId !== "object") {
              authIds.push(String(d.authUserId).trim());
            }
          }
          if (authIds.length) {
            debug(
              "ws: Connection addmodel authUserIds in frame (" + authIds.length + "):",
              authIds.slice(0, 12),
              authIds.length > 12 ? "…" : "",
              "| expect",
              authUserId,
              authIds.includes(String(authUserId).trim()) ? "(yours present)" : "(yours missing)"
            );
            loggedConnectionMismatch = true;
          }
        }
      }
    });
  });
}

/**
 * Opens a WebSocket to Gather, authenticates, connects to space, loads space user, enters space,
 * and resolves when the connection is ready for actions. Caller must have valid creds with
 * spaceId, authUserId, spaceUserId.
 */
export function createGatherConnection(
  creds: GatherCredentials,
  onClose?: (code: number, reason?: Buffer) => void,
  onKnownSpaceUserIds?: (ids: string[]) => void,
  opts?: GatherConnectionOptions
): Promise<WebSocket> {
  return new Promise(async (resolve, reject) => {
    const jwt = await getValidJwt(creds);
    const spaceId = creds.spaceId!;
    const authUserId = creds.authUserId!;
    const spaceUserId = creds.spaceUserId!;
    const url = buildWsUrl(spaceId, authUserId);
    debug("ws: connecting", url.slice(0, 80) + "...");
    const socket = new WebSocket(url, { headers: GAME_WS_HEADERS });
    socket.binaryType = "arraybuffer";
    let resolved = false;
    const onReady = (reason: string) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      debug("ws: ready (" + reason + ")");
      resolve(socket);
    };
    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      debug("ws: ready (timeout)");
      resolve(socket);
    }, WAIT_FOR_FIRST_MSG_MS);

    let hasEnteredSpace = false;
    const knownSpaceUserIds = new Set<string>();

    const collectSpaceUserIdsFromPatches = (patches: unknown[], replace = false): void => {
      if (replace) knownSpaceUserIds.clear();
      for (const patch of patches) {
        if (!patch || typeof patch !== "object") continue;
        const p = patch as { model?: unknown; data?: unknown };
        if (p.model !== "SpaceUser" || !p.data || typeof p.data !== "object") continue;
        const id = (p.data as { id?: unknown }).id;
        if (typeof id === "string" && id.trim().length > 0) {
          knownSpaceUserIds.add(id);
        }
      }
      onKnownSpaceUserIds?.([...knownSpaceUserIds]);
    };

    socket.on("open", () => {
      debug("ws: open");
      connectAndSubscribe(socket, jwt, spaceId);
    });
    socket.on("error", (err) => {
      debug("ws: error", err.message ?? err);
      clearTimeout(timeout);
      reject(err);
    });
    socket.on("close", (code, reason) => {
      debug("ws: close", code, reason?.toString() || "");
      if (code === 4030) {
        console.warn("Server closed connection (4030). Often auth/session invalid.");
      }
      onClose?.(code, reason as Buffer);
    });
    socket.on("message", (data: Buffer | ArrayBuffer) => {
      try {
        const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as Buffer);
        const msg = decode(buf) as any;
        const msgType = msg?.type;
        if (DEBUG && msgType && msgType !== "Heartbeat") {
          const preview = JSON.stringify(msg).slice(0, 200);
          debug("ws: message", msgType, preview);
          if (msg.actionReturns?.length) debug("ws: actionReturns", JSON.stringify(msg.actionReturns).slice(0, 300));
          if (msg.error) debug("ws: error from server", msg.error);
        }

        // Track all known users from state snapshots/patches.
        if (msgType === "FullStateChunk" && Array.isArray(msg.fullStatePatches)) {
          collectSpaceUserIdsFromPatches(msg.fullStatePatches, true);
        } else if (msgType === "DeltaState" && Array.isArray(msg.patches)) {
          collectSpaceUserIdsFromPatches(msg.patches);
        }

        if (msgType && !hasEnteredSpace) {
          hasEnteredSpace = true;
          if (opts?.copierId) {
            sendLoadSpaceUserAsGuest(socket, opts.copierId);
          } else {
            sendLoadSpaceUser(socket);
          }
          sendEnterSpace(socket, spaceUserId);
          setTimeout(() => onReady(msgType === "Heartbeat" ? "Heartbeat" : msgType), 800);
        }
      } catch {
        const len = data instanceof ArrayBuffer ? data.byteLength : (data as Buffer).length;
        if (DEBUG) debug("ws: message (raw)", len, "bytes");
        if (!hasEnteredSpace) {
          hasEnteredSpace = true;
          if (opts?.copierId) {
            sendLoadSpaceUserAsGuest(socket, opts.copierId);
          } else {
            sendLoadSpaceUser(socket);
          }
          sendEnterSpace(socket, spaceUserId);
          setTimeout(() => onReady("raw message"), 800);
        } else {
          onReady("raw message");
        }
      }
    });
  });
}

/** Validates JWT matches authUserId in creds; throws or exits on mismatch. */
export async function validateAccountMatch(creds: GatherCredentials): Promise<void> {
  const authUserId = creds.authUserId!;
  const jwt = await getValidJwt(creds);
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      sub?: string;
      user_id?: string;
      gather?: { userAccountId?: string };
    };
    const jwtUid = payload.user_id ?? payload.sub;
    if (DEBUG) debug("JWT payload: sub=" + payload.sub + " gather.userAccountId=" + payload.gather?.userAccountId);
    if (jwtUid && authUserId && jwtUid !== authUserId) {
      console.error("");
      console.error("Account mismatch: the refresh token is for a different user than authUserId in credentials.");
      console.error("  JWT user_id/sub:    " + jwtUid);
      console.error("  authUserId in credentials: " + authUserId);
      console.error("");
      console.error("Fix: use one HAR from a single session so token and IDs match.");
      console.error("  1. Open https://app.v2.gather.town in an incognito window.");
      console.error("  2. Sign in with the account you want, open your space, set/clear status once.");
      console.error("  3. DevTools → Network → Save all as HAR (e.g. chrome.har).");
      console.error("  4. Run: yarn start login chrome.har");
      console.error("  5. Start this app again.");
      console.error("");
      process.exit(1);
    }
  } catch {
    // ignore parse errors
  }
}
