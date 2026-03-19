import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { encode, decode } from "@msgpack/msgpack";
import type { GatherCredentials } from "./auth.js";
import { getValidJwt } from "./auth.js";
import { GATHER_WS_URL } from "./config.js";
import { debug, DEBUG } from "./debug.js";

const DRY_RUN = process.env.DRY === "1";

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

/** HAR: connectionData is { type: 4, data: {} }, not raw bytes. */
export function connectAndSubscribe(ws: WebSocket, jwt: string, spaceId: string): void {
  debug("ws: sending Authenticate (JWT length:", jwt.length, ")");
  sendAuthenticate(ws, jwt);
  debug("ws: sending ConnectToSpace", spaceId.slice(0, 8) + "...");
  sendEncoded(ws, {
    type: "ConnectToSpace",
    spaceId,
    connectionData: { type: 4, data: {} },
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
        invitationId: { type: 4, data: {} },
        spawnAreaId: { type: 4, data: {} },
      },
    ],
  });
  debug("ws: sent loadSpaceUser");
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

const WAIT_FOR_FIRST_MSG_MS = 10000;

/**
 * Opens a WebSocket to Gather, authenticates, connects to space, loads space user, enters space,
 * and resolves when the connection is ready for actions. Caller must have valid creds with
 * spaceId, authUserId, spaceUserId.
 */
export function createGatherConnection(
  creds: GatherCredentials,
  onClose?: (code: number, reason?: Buffer) => void,
  onKnownSpaceUserIds?: (ids: string[]) => void
): Promise<WebSocket> {
  return new Promise(async (resolve, reject) => {
    const jwt = await getValidJwt(creds);
    const spaceId = creds.spaceId!;
    const authUserId = creds.authUserId!;
    const spaceUserId = creds.spaceUserId!;
    const url = buildWsUrl(spaceId, authUserId);
    debug("ws: connecting", url.slice(0, 80) + "...");
    const socket = new WebSocket(url);
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
          sendLoadSpaceUser(socket);
          sendEnterSpace(socket, spaceUserId);
          setTimeout(() => onReady(msgType === "Heartbeat" ? "Heartbeat" : msgType), 800);
        }
      } catch {
        const len = data instanceof ArrayBuffer ? data.byteLength : (data as Buffer).length;
        if (DEBUG) debug("ws: message (raw)", len, "bytes");
        if (!hasEnteredSpace) {
          hasEnteredSpace = true;
          sendLoadSpaceUser(socket);
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
