import portAudio from "@capaj/naudiodon";
import { decode } from "@msgpack/msgpack";
import WebSocket from "ws";
import { io, type Socket } from "socket.io-client";
import wrtc from "@roamhq/wrtc";

import { buildGuestJoinUrl, GATHER_APP_ORIGIN } from "../utility/config.js";
import { DEBUG, debug } from "../utility/debug.js";
import {
  getAppleMusicNowPlayingDisplayName,
  truncateGatherDisplayName,
} from "../utility/apple-music.js";
import {
  createAnonymousGuestSession,
  ensureLoggedIn,
  getValidJwt,
  signInWithGatherCustomToken,
  type GatherCredentials,
} from "../utility/auth.js";
import {
  fetchMe,
  fetchSpaceRosterUserAccountIds,
  fetchUserAccountIdForFirebaseAuthId,
  fetchUserAccountIdForSpaceUser,
  primeGuestJoinPage,
} from "../utility/gather-api.js";
import {
  collectPeerHintsFromGameStateMessage,
  findMapAreaIdByCanonicalName,
  GATHER_GAME_WS_CLOSE_LEAVE_OFFICE,
  mergeMapAreaLayoutsFromGameMessage,
  mergeSpaceUserGridPositionsFromGameMessage,
  openGuestGameSocketForCheckIn,
  resolveMapAreaWorldRect,
  sendClearStatus,
  sendEnterSpace,
  sendGetAuthenticationDataSpotify,
  sendSetCustomStatus,
  sendTeleport,
  waitForGuestPassAdmitted,
  type MapAreaLayoutEntry,
} from "../utility/gather-ws.js";

const AUDIO_DEVICE_NAME = "BlackHole 2ch";
const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const GATHER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) GatherV2/0.39.1 Chrome/144.0.7559.177 Electron/40.6.0 Safari/537.36";

/**
 * **`@roamhq/wrtc` `RTCAudioSource.onData`** requires **`numberOfFrames === 480`** (10ms at 48kHz stereo int16).
 * PortAudio can still read a **multiple** of that per native callback; we slice into **480**-frame chunks for WebRTC.
 */
const WEBRTC_AUDIO_FRAMES = 480;

/**
 * **`framesPerBuffer`** for PortAudio = **`WEBRTC_AUDIO_FRAMES` × multiplier** (fewer native callbacks when **> 1**).
 * Env **`DJ_PORTAUDIO_BUFFER_MULTIPLIER`**: integer **1–8**, default **8**.
 */
const PORTAUDIO_BUFFER_MULTIPLIER = ((): number => {
  const raw = process.env.DJ_PORTAUDIO_BUFFER_MULTIPLIER?.trim();
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return 8;
  return Math.min(8, n);
})();
const PORTAUDIO_FRAMES_PER_BUFFER = WEBRTC_AUDIO_FRAMES * PORTAUDIO_BUFFER_MULTIPLIER;

/** Top-level `gather.userAccountId` on Firebase **client** id_token (guest2.har router CONNECT). */
function gatherUserAccountIdFromFirebaseJwt(jwt: string): string | null {
  try {
    const p = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      gather?: { userAccountId?: string };
    };
    const id = p.gather?.userAccountId;
    return typeof id === "string" && id.trim() ? id.trim() : null;
  } catch {
    return null;
  }
}

const UUID_RE = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

function isUuidString(s: string): boolean {
  return UUID_RE.test(s.trim());
}

/** Coworking **MapArea** `name` from game state (`voice.har`); guest **`teleport`**s here and stays inside the tile bounds (`poof.har`). */
const DJ_STAY_AREA_NAME = "Dance Floor";

/** Poll **Music.app** to refresh **`setCustomStatus`** (macOS only). */
const DJ_APPLE_MUSIC_STATUS_POLL_MS = 3000;

/** Emoji for DJ **now playing** custom status (`setCustomStatus`). */
const DJ_NOW_PLAYING_STATUS_EMOJI = "🎵";

/**
 * SFU **server-info** `producers…[].c` map keys are **Gather userAccount ids** (same id space as **`consume-request` `srcId`** — see `voice.har`).
 */
function extractUserAccountIdsFromSfuServerInfo(payload: unknown): string[] {
  const out = new Set<string>();
  const walk = (obj: unknown, depth: number): void => {
    if (depth > 16 || obj === null || typeof obj !== "object") return;
    if (Array.isArray(obj)) {
      for (const x of obj) walk(x, depth + 1);
      return;
    }
    const rec = obj as Record<string, unknown>;
    const c = rec.c;
    if (c !== null && typeof c === "object" && !Array.isArray(c)) {
      for (const k of Object.keys(c)) {
        const t = k.trim();
        if (UUID_RE.test(t)) out.add(t);
      }
    }
    for (const v of Object.values(rec)) walk(v, depth + 1);
  };
  walk(payload, 0);
  return [...out];
}

function findDeviceIdByName(name: string): number {
  const devices = portAudio.getDevices();
  const found = devices.find((d: any) => String(d.name) === name && Number(d.maxInputChannels) > 0);
  if (!found) {
    console.error(`Audio input device not found: "${name}"`);
    console.error("Available input devices:");
    for (const d of devices) {
      if (Number((d as any).maxInputChannels) > 0) {
        console.error(`- id=${(d as any).id} name="${(d as any).name}" host="${(d as any).hostAPIName}"`);
      }
    }
    process.exit(1);
  }
  return Number((found as any).id);
}

async function getSfuAddr(spaceId: string, routerAuthToken: string, userAccountId: string): Promise<string> {
  const socket = io("wss://router.v2.gather.town", {
    path: "/socket.io/",
    transports: ["websocket"],
    // guest2.har: auth.token is always Firebase securetoken JWT (not users/me `token`).
    auth: { spaceId, token: routerAuthToken },
    autoConnect: false,
    reconnection: false,
    extraHeaders: {
      Origin: GATHER_APP_ORIGIN,
      "User-Agent": GATHER_UA,
      "Accept-Language": "en-US",
    },
  });

  const cleanup = () => {
    try {
      socket.disconnect();
    } catch {
      /* ignore */
    }
  };

  return await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out getting SFU addr"));
    }, 15000);

    socket.on("connect_error", (err) => {
      debug("dj: router connect_error", err.message, (err as any).data ?? null);
      clearTimeout(t);
      cleanup();
      reject(err);
    });

    socket.on("connect", () =>
      socket.emit("get-addr", { srcId: userAccountId, srcStreamId: spaceId })
    );

    socket.on("addrs", (payload: any) => {
      const sfuAddr = payload?.sfuAddr;
      if (typeof sfuAddr === "string" && sfuAddr.startsWith("wss://")) {
        clearTimeout(t);
        cleanup();
        resolve(sfuAddr);
      }
    });

    socket.connect();
  });
}

function connectSfuSocket(sfuWsBase: string, spaceId: string, routerAuthToken: string): Socket {
  const u = new URL(sfuWsBase);
  const origin = `${u.protocol}//${u.host}`;
  const pathPrefix = u.pathname.replace(/\/$/, "");
  const path = `${pathPrefix}/socket.io`;
  const sessionId = u.searchParams.get("sessionId");

  const socket = io(origin, {
    path: path.endsWith("/") ? path : `${path}/`,
    transports: ["websocket"],
    auth: { spaceId, token: routerAuthToken },
    ...(sessionId ? { query: { sessionId } } : {}),
    reconnection: false,
    extraHeaders: {
      Origin: GATHER_APP_ORIGIN,
      "User-Agent": GATHER_UA,
      "Accept-Language": "en-US",
    },
  });
  return socket;
}

async function sfuRequest<T>(socket: Socket, event: string, payload: any, timeoutMs = 15000): Promise<T> {
  return await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`SFU request timed out: ${event}`)), timeoutMs);
    socket.emit(event, payload, (resp: any) => {
      clearTimeout(t);
      resolve(resp as T);
    });
  });
}

const SFU_DEBUG_PAYLOAD_MAX = 8000;

function formatSfuDebugPayload(args: unknown[]): string {
  return args
    .map((a) => {
      if (a === undefined) return "(undefined)";
      if (typeof a === "function") return "(ack callback)";
      if (typeof a === "object" && a !== null) {
        try {
          const s = JSON.stringify(a);
          return s.length > SFU_DEBUG_PAYLOAD_MAX ? `${s.slice(0, SFU_DEBUG_PAYLOAD_MAX)}…(truncated)` : s;
        } catch {
          return Object.prototype.toString.call(a);
        }
      }
      return String(a);
    })
    .join(" || ");
}

/** When `DEBUG=1`, log every SFU Socket.IO event in both directions (all voice signaling). */
function attachSfuDebugTrafficLog(sfuSocket: Socket): void {
  if (!DEBUG) return;
  sfuSocket.onAny((event, ...args: unknown[]) => {
    debug("dj: sfu recv", event, formatSfuDebugPayload(args));
  });
  sfuSocket.onAnyOutgoing((event, ...args: unknown[]) => {
    debug("dj: sfu send", event, formatSfuDebugPayload(args));
  });
}

/**
 * Guest DJ: `auth.json` space + host **spaceUserId** as inviter (`copierid`), anonymous guest session,
 * game WS + SFU **produce** + **`consume-allow`** per listener.
 *
 * **`consume-allow` `dstId`** is the listener’s **Gather `userAccount.id` UUID** (not `spaceUserId`). Confirmed in **`voice.har`**:
 * `consume-request` uses `zodData.srcId` = producer’s userAccount id; the joiner then sends **`consume-allow`** with `dstId` = each other participant’s **userAccount** id.
 * We discover **space user ids** from game state and map **spaceUser → userAccount** via REST where needed; we also use **server-info** `c` keys and host roster hints.
 * The guest sends **`teleport` once** to the **bottom row** of the **Dance Floor** (**`maxY`**), **horizontally centered**, facing **Up** (`poof.har`); when **SpaceUser** grid position shows they’re inside the area, the nav timer is cleared.
 * On **macOS**, **`setCustomStatus`** shows **Apple Music** now playing (**`title - artist`**); the in-space **name** stays **`GATHER_GUEST_NAME`** or **`DJ`**. When Music stops, **`clearCustomStatus`** runs.
 */
export async function runDj(): Promise<void> {
  const hostCreds = await ensureLoggedIn();
  const spaceId = hostCreds.spaceId!;
  const hostSpaceUserId = hostCreds.spaceUserId;
  if (!hostSpaceUserId) {
    console.error("dj: missing host spaceUserId. Run login and enter the space once (base-calendar-events).");
    process.exit(1);
  }

  const hostJwt = await getValidJwt(hostCreds);
  const hostMe = await fetchMe(hostJwt, spaceId);
  const hostUserAccountId = hostMe.userAccountId;
  if (!hostUserAccountId) {
    console.error(
      "dj: host GET /users/me missing userAccount.id. SFU consume-allow dstId uses Gather userAccount UUIDs (see voice.har)."
    );
    process.exit(1);
  }

  const derivedUrl = buildGuestJoinUrl(spaceId, hostSpaceUserId);
  debug("dj: equivalent guest join URL", derivedUrl);

  console.log("Creating anonymous guest session…");
  const creds: GatherCredentials = await createAnonymousGuestSession(spaceId);

  const guestJwtForPrime = await getValidJwt(creds);
  console.log("Priming guest join (same URL the browser loads)…");
  await primeGuestJoinPage(guestJwtForPrime, derivedUrl);

  let gameWs: WebSocket | null = null;
  let guestSpaceUserId: string;
  let danceFloorNavTimer: ReturnType<typeof setInterval> | undefined;
  let appleMusicStatusTimer: ReturnType<typeof setInterval> | undefined;
  /** Latest grid tile per **SpaceUser** id from game state (for Dance Floor navigation). */
  const spaceUserGridPos = new Map<string, { x: number; y: number }>();
  /** **MapArea** layouts from game state (relative tiles + **Dance Floor** name). */
  const mapAreaLayouts = new Map<string, MapAreaLayoutEntry>();
  /** `UserAccount` / full **SpaceUser** rows ship in early **FullStateChunk** / big **DeltaState** before SFU setup; buffer until `onGameMessageForVoicePeers` exists, then replay. */
  const preVoicePeerGameMessages: unknown[] = [];
  let deliverGameMessageToVoicePeers: ((msg: unknown) => void) | undefined;

  const onGuestGameWsBinary = (data: Buffer | ArrayBuffer): void => {
    try {
      const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as Buffer);
      const msg = decode(buf) as unknown;
      mergeSpaceUserGridPositionsFromGameMessage(msg, spaceUserGridPos);
      mergeMapAreaLayoutsFromGameMessage(msg, mapAreaLayouts);
      if (deliverGameMessageToVoicePeers) deliverGameMessageToVoicePeers(msg);
      else preVoicePeerGameMessages.push(msg);
    } catch {
      /* ignore */
    }
  };

  try {
    console.log("Connecting to game server (guest check-in)…");
    const checkIn = await openGuestGameSocketForCheckIn(creds, hostSpaceUserId, () => {
      gameWs = null;
    });
    gameWs = checkIn.ws;
    /** Before `guestSpaceUserId` resolves, the server may already send **FullStateChunk** / **DeltaState** with **UserAccount** / **SpaceUser** rows — attach immediately. */
    gameWs.on("message", onGuestGameWsBinary);
    console.log(
      "Waiting for host approval… Stay in this space in the Gather app (same member as `yarn login`) with the window open."
    );
    guestSpaceUserId = await checkIn.guestSpaceUserId;
    debug("dj: guest spaceUserId (from game Connection)", guestSpaceUserId.slice(0, 8) + "…");
    await waitForGuestPassAdmitted(gameWs, guestSpaceUserId);
    creds.spaceUserId = guestSpaceUserId;
    if (gameWs.readyState === WebSocket.OPEN) {
      sendEnterSpace(gameWs, guestSpaceUserId);
      sendGetAuthenticationDataSpotify(gameWs);
      debug("dj: enterSpace + getAuthenticationData after GuestPass Admitted (guest2.har)");
      let danceFloorRectLogged = false;
      const GRID_NAV_TICK_MS = 130;
      let danceFloorTeleportSent = false;
      danceFloorNavTimer = setInterval(() => {
        if (!gameWs || gameWs.readyState !== WebSocket.OPEN) return;
        const areaId = findMapAreaIdByCanonicalName(mapAreaLayouts, DJ_STAY_AREA_NAME);
        const rect = areaId ? resolveMapAreaWorldRect(mapAreaLayouts, areaId) : null;
        if (DEBUG && rect && !danceFloorRectLogged) {
          debug("dj: Dance Floor world rect", rect);
          danceFloorRectLogged = true;
        }
        const g = spaceUserGridPos.get(guestSpaceUserId);
        if (!g || !rect) return;

        if (g.x >= rect.minX && g.x <= rect.maxX && g.y >= rect.minY && g.y <= rect.maxY) {
          if (danceFloorNavTimer !== undefined) {
            clearInterval(danceFloorNavTimer);
            danceFloorNavTimer = undefined;
          }
          return;
        }

        if (danceFloorTeleportSent) return;

        const tx = Math.floor((rect.minX + rect.maxX) / 2);
        const ty = rect.maxY;
        sendTeleport(gameWs, guestSpaceUserId, tx, ty, "Up");
        danceFloorTeleportSent = true;
        if (DEBUG) debug("dj: teleport to Dance Floor bottom row, horizontal center (once)", [tx, ty], "face Up");
      }, GRID_NAV_TICK_MS);
      danceFloorNavTimer.unref?.();

      /** `null` = no status set yet; `""` = cleared; else last **setCustomStatus** text. */
      let lastCustomStatusText: string | null = null;
      if (process.platform === "darwin") {
        appleMusicStatusTimer = setInterval(() => {
          if (!gameWs || gameWs.readyState !== WebSocket.OPEN) return;
          const fromMusic = getAppleMusicNowPlayingDisplayName();
          if (fromMusic?.trim()) {
            const text = truncateGatherDisplayName(fromMusic.trim());
            if (text === lastCustomStatusText) return;
            lastCustomStatusText = text;
            sendSetCustomStatus(gameWs, guestSpaceUserId, text, DJ_NOW_PLAYING_STATUS_EMOJI);
            if (DEBUG) debug("dj: setCustomStatus (now playing)", text);
          } else {
            if (lastCustomStatusText === null || lastCustomStatusText === "") return;
            lastCustomStatusText = "";
            sendClearStatus(gameWs, guestSpaceUserId);
            if (DEBUG) debug("dj: clearCustomStatus (Music not playing)");
          }
        }, DJ_APPLE_MUSIC_STATUS_POLL_MS);
        appleMusicStatusTimer.unref?.();
      }
    }
  } catch (err) {
    console.error("dj: game WebSocket guest flow failed:", err);
    process.exit(1);
  }

  // guest2.har: router `auth.token` is Firebase **id_token** with `gather.userAccountId`. Anonymous signUp id_token has no `gather`;
  // the app then GETs users/me and POSTs `accounts:signInWithCustomToken` with `users/me.token` (Gather custom token) to mint that id_token.
  // securetoken refresh alone never adds `gather` — same anonymous session.
  let me = await fetchMe(creds.accessToken!, spaceId);
  if (me.spaceToken) {
    await signInWithGatherCustomToken(creds, me.spaceToken);
    creds.gatherSpaceSessionToken = me.spaceToken;
  }
  await new Promise((r) => setTimeout(r, 350));
  me = await fetchMe(creds.accessToken!, spaceId);
  if (me.spaceToken && !gatherUserAccountIdFromFirebaseJwt(creds.accessToken!)) {
    await signInWithGatherCustomToken(creds, me.spaceToken);
    creds.gatherSpaceSessionToken = me.spaceToken;
  }

  if (!me.userAccountId) {
    console.error(
      "dj: GET /users/me did not return userAccount.id (Gather UUID). The voice router requires that id as get-addr srcId — not the Firebase uid."
    );
    process.exit(1);
  }
  const userAccountId = me.userAccountId;
  const guestAuthUserId = me.authUserId;
  const firebaseJwt = creds.accessToken!;
  const fbGather = gatherUserAccountIdFromFirebaseJwt(firebaseJwt);
  const srcIdForRouter = fbGather ?? userAccountId;
  const authKind = fbGather
    ? "Firebase id_token + gather.userAccountId (guest2.har)"
    : "Firebase id_token + get-addr srcId from users/me userAccount.id (no gather claim on JWT yet)";

  if (!fbGather) {
    console.warn(
      "dj: Firebase id_token missing gather.userAccountId; router may reject. guest2.har uses JWT with gather claim for auth.token."
    );
  }

  const routerToken = firebaseJwt;

  debug("dj: router auth", authKind);
  debug("dj: router get-addr srcId", srcIdForRouter.slice(0, 8) + "…");

  debug("dj: resolving SFU address...");
  const sfuAddr = await getSfuAddr(spaceId, routerToken, srcIdForRouter);
  debug("dj: sfuAddr", sfuAddr);

  const sfuSocket = connectSfuSocket(sfuAddr, spaceId, routerToken);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("SFU socket connect timeout")), 15000);
    sfuSocket.on("connect_error", (err) => {
      debug("dj: sfu connect_error", err.message, (err as any).data ?? null);
      clearTimeout(t);
      reject(err);
    });
    sfuSocket.on("connect", () => {
      clearTimeout(t);
      resolve();
    });
  });

  attachSfuDebugTrafficLog(sfuSocket);

  let wsSequenceNumber = 1;

  const consumeAllowDstSent = new Set<string>();
  const emitConsumeAllow = (dstUserAccountId: string): void => {
    const id = dstUserAccountId.trim();
    if (!isUuidString(id) || id === userAccountId || id === srcIdForRouter || id === spaceId) return;
    if (consumeAllowDstSent.has(id)) return;
    consumeAllowDstSent.add(id);
    sfuSocket.emit("consume-allow", {
      wsSequenceNumber: wsSequenceNumber++,
      zodData: { dstId: id, allowed: true },
    });
  };

  const pendingConsumeAllowUserAccountIds = new Set<string>();
  let voiceProducerReady = false;

  const flushConsumeAllowForPeerAccount = (peerUserAccountId: string): void => {
    emitConsumeAllow(peerUserAccountId.trim());
  };

  const invitePeerAccountForDjsAudio = (peerUserAccountId: string): void => {
    const id = peerUserAccountId.trim();
    if (!isUuidString(id) || id === userAccountId || id === srcIdForRouter || id === spaceId) return;
    if (voiceProducerReady) flushConsumeAllowForPeerAccount(id);
    else pendingConsumeAllowUserAccountIds.add(id);
  };

  const allSeenSpaceUserIds = new Set<string>();
  /** From game **SpaceUser** patches: `data.id` → `data.userAccountId` (`voice.har`); avoids useless REST when the server omits `UserAccount` rows for guests. */
  const spaceUserIdToUserAccountId = new Map<string, string>();
  const resolveSpaceUserInFlight = new Set<string>();
  const allSeenFirebaseAuthIds = new Set<string>();
  const resolveFirebaseAuthInFlight = new Set<string>();

  const considerFirebaseAuthForVoice = (firebaseAuthId: string): void => {
    const fid = firebaseAuthId.trim();
    if (fid.length < 8 || fid === guestAuthUserId) return;
    allSeenFirebaseAuthIds.add(fid);
    if (resolveFirebaseAuthInFlight.has(fid)) return;
    resolveFirebaseAuthInFlight.add(fid);
    void (async () => {
      try {
        const acc =
          (await fetchUserAccountIdForFirebaseAuthId(hostJwt, fid)) ??
          (await fetchUserAccountIdForFirebaseAuthId(firebaseJwt, fid));
        if (acc) invitePeerAccountForDjsAudio(acc);
      } finally {
        resolveFirebaseAuthInFlight.delete(fid);
      }
    })();
  };

  const considerSpaceUserForVoiceInvite = (spaceUserId: string): void => {
    const su = spaceUserId.trim();
    if (!isUuidString(su) || su === guestSpaceUserId) return;
    allSeenSpaceUserIds.add(su);
    if (su === hostSpaceUserId) {
      invitePeerAccountForDjsAudio(hostUserAccountId);
      return;
    }
    const fromState = spaceUserIdToUserAccountId.get(su);
    if (fromState) {
      invitePeerAccountForDjsAudio(fromState);
      return;
    }
    if (resolveSpaceUserInFlight.has(su)) return;
    resolveSpaceUserInFlight.add(su);
    void (async () => {
      try {
        const acc =
          (await fetchUserAccountIdForSpaceUser(hostJwt, spaceId, su)) ??
          (await fetchUserAccountIdForSpaceUser(firebaseJwt, spaceId, su));
        if (acc) invitePeerAccountForDjsAudio(acc);
      } finally {
        resolveSpaceUserInFlight.delete(su);
      }
    })();
  };

  const onGameMessageForVoicePeers = (msg: unknown): void => {
    const hints = collectPeerHintsFromGameStateMessage(msg);
    for (const [su, ua] of Object.entries(hints.spaceUserToUserAccountId)) {
      const s = su.trim();
      const a = ua.trim();
      if (isUuidString(s) && isUuidString(a)) spaceUserIdToUserAccountId.set(s, a);
    }
    for (const id of hints.userAccountIds) invitePeerAccountForDjsAudio(id);
    for (const su of hints.spaceUserIds) considerSpaceUserForVoiceInvite(su);
    for (const fid of hints.firebaseAuthIds) considerFirebaseAuthForVoice(fid);
  };

  const consumerHintKeys = [
    "dstId",
    "consumerSrcId",
    "requesterSrcId",
    "requestingSrcId",
    "requesterUserAccountId",
    "consumerUserAccountId",
  ] as const;

  sfuSocket.onAny((event, ...args: unknown[]) => {
    if (event === "server-info" && args[0] !== undefined) {
      const fromC = extractUserAccountIdsFromSfuServerInfo(args[0]);
      for (const id of fromC) invitePeerAccountForDjsAudio(id);
    }
    if (
      event === "connect" ||
      event === "disconnect" ||
      event === "connect_error" ||
      event === "client-ip-info" ||
      event === "server-info"
    ) {
      return;
    }
    const raw = args[0];
    if (typeof raw !== "object" || raw === null) return;
    const top = raw as Record<string, unknown>;
    const zod =
      top.zodData !== undefined && typeof top.zodData === "object" && top.zodData !== null
        ? (top.zodData as Record<string, unknown>)
        : top;

    const looksLikeConsumePermission =
      /consume/i.test(event) || (typeof zod.dstId === "string" && zod.requested === true);

    if (looksLikeConsumePermission) {
      for (const k of consumerHintKeys) {
        const v = zod[k];
        if (typeof v === "string") invitePeerAccountForDjsAudio(v);
      }
    }
  });

  deliverGameMessageToVoicePeers = onGameMessageForVoicePeers;
  if (preVoicePeerGameMessages.length > 0) {
    debug("dj: replaying buffered game frames for voice peers", preVoicePeerGameMessages.length);
    const backlog = preVoicePeerGameMessages.splice(0, preVoicePeerGameMessages.length);
    for (const m of backlog) onGameMessageForVoicePeers(m);
  }

  invitePeerAccountForDjsAudio(hostUserAccountId);

  const voiceRescanTimer = setInterval(() => {
    for (const su of allSeenSpaceUserIds) considerSpaceUserForVoiceInvite(su);
    for (const fid of allSeenFirebaseAuthIds) considerFirebaseAuthForVoice(fid);
  }, 8000);
  voiceRescanTimer.unref?.();

  let hostRosterPollTimer: ReturnType<typeof setInterval> | undefined;
  const pollHostRoster = (): void => {
    void (async () => {
      try {
        const roster = await fetchSpaceRosterUserAccountIds(hostJwt, spaceId);
        if (roster.length > 0) debug("dj: host roster resolved", roster.length, "userAccount id(s)");
        for (const id of roster) invitePeerAccountForDjsAudio(id);
      } catch {
        /* ignore */
      }
    })();
  };
  pollHostRoster();
  hostRosterPollTimer = setInterval(pollHostRoster, 12_000);
  hostRosterPollTimer.unref?.();

  const routerCapsResp = await sfuRequest<any>(
    sfuSocket,
    "get-rtp-capabilities",
    { wsSequenceNumber: wsSequenceNumber++ }
  );
  const routerRtpCapabilities = routerCapsResp?.routerRtpCapabilities ?? routerCapsResp;

  (globalThis as any).RTCPeerConnection = (wrtc as any).RTCPeerConnection;
  (globalThis as any).RTCSessionDescription = (wrtc as any).RTCSessionDescription;
  (globalThis as any).RTCIceCandidate = (wrtc as any).RTCIceCandidate;
  (globalThis as any).MediaStream = (wrtc as any).MediaStream;
  (globalThis as any).MediaStreamTrack = (wrtc as any).MediaStreamTrack;

  const { Device } = await import("mediasoup-client");
  const device = new Device({ handlerName: "Chrome74" });
  await device.load({ routerRtpCapabilities });

  const transportCreateResp = await sfuRequest<any>(sfuSocket, "transport-create", {
    wsSequenceNumber: wsSequenceNumber++,
    zodData: {
      direction: "send",
      iceTransportRequestOptions: { forceTurn: false, trafficAccelerator: "GlobalAccelerator" },
    },
  });

  const sendTransport = device.createSendTransport({
    id: transportCreateResp.id,
    iceParameters: transportCreateResp.iceParameters,
    iceCandidates: transportCreateResp.iceCandidates,
    dtlsParameters: transportCreateResp.dtlsParameters,
    sctpParameters: transportCreateResp.sctpParameters,
    iceServers: [],
  });

  sendTransport.on("connect", ({ dtlsParameters }, callback, errback) => {
    void (async () => {
      try {
        await sfuRequest<any>(sfuSocket, "transport-connect", {
          wsSequenceNumber: wsSequenceNumber++,
          zodData: { transportId: sendTransport.id, dtlsParameters },
        });
        callback();
      } catch (err) {
        errback(err as Error);
      }
    })();
  });

  sendTransport.on("produce", ({ kind, rtpParameters, appData }, callback, errback) => {
    void (async () => {
      try {
        const resp = await sfuRequest<any>(sfuSocket, "produce", {
          wsSequenceNumber: wsSequenceNumber++,
          zodData: { transportId: sendTransport.id, tag: appData?.tag ?? "audio", kind, rtpParameters },
        });
        callback({ id: resp?.id });
      } catch (err) {
        errback(err as Error);
      }
    })();
  });

  const deviceId = findDeviceIdByName(AUDIO_DEVICE_NAME);
  debug("dj: using audio device", AUDIO_DEVICE_NAME, "id", deviceId);

  const { nonstandard } = wrtc as any;
  const source = new nonstandard.RTCAudioSource();
  const track = source.createTrack();

  const producer = await sendTransport.produce({
    track,
    encodings: [{ maxBitrate: 256_000 }],
    codecOptions: {
      opusStereo: true,
      opusFec: true,
      opusDtx: false,
      opusMaxPlaybackRate: 48000,
    },
    appData: { tag: "audio" },
  });

  voiceProducerReady = true;
  const queued = [...pendingConsumeAllowUserAccountIds];
  pendingConsumeAllowUserAccountIds.clear();
  for (const id of queued) flushConsumeAllowForPeerAccount(id);

  const ai = new (portAudio as any).AudioIO({
    inOptions: {
      channelCount: CHANNELS,
      sampleFormat: (portAudio as any).SampleFormat16Bit,
      sampleRate: SAMPLE_RATE,
      deviceId,
      framesPerBuffer: PORTAUDIO_FRAMES_PER_BUFFER,
      closeOnError: true,
    },
  });

  let leftover = Buffer.alloc(0);
  const bytesPerFrame = CHANNELS * 2;
  const bytesPerWebRtcChunk = WEBRTC_AUDIO_FRAMES * bytesPerFrame;

  ai.on("data", (buf: Buffer) => {
    leftover = Buffer.concat([leftover, buf]);
    while (leftover.length >= bytesPerWebRtcChunk) {
      const frame = leftover.subarray(0, bytesPerWebRtcChunk);
      leftover = leftover.subarray(bytesPerWebRtcChunk);
      const samples = new Int16Array(
        frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength)
      );
      source.onData({
        samples,
        sampleRate: SAMPLE_RATE,
        bitsPerSample: 16,
        channelCount: CHANNELS,
        numberOfFrames: WEBRTC_AUDIO_FRAMES,
      });
    }
  });

  ai.on("error", (err: any) => {
    console.warn("dj: audio capture error:", err);
  });

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    debug("dj: stopping…");

    try {
      clearInterval(voiceRescanTimer);
    } catch {
      /* ignore */
    }
    try {
      if (danceFloorNavTimer) clearInterval(danceFloorNavTimer);
    } catch {
      /* ignore */
    }
    try {
      if (appleMusicStatusTimer) clearInterval(appleMusicStatusTimer);
    } catch {
      /* ignore */
    }
    try {
      if (hostRosterPollTimer) clearInterval(hostRosterPollTimer);
    } catch {
      /* ignore */
    }
    try {
      if (
        process.platform === "darwin" &&
        gameWs?.readyState === WebSocket.OPEN &&
        typeof guestSpaceUserId === "string"
      ) {
        sendClearStatus(gameWs, guestSpaceUserId);
      }
    } catch {
      /* ignore */
    }
    try {
      if (gameWs?.readyState === WebSocket.OPEN) {
        gameWs.close(GATHER_GAME_WS_CLOSE_LEAVE_OFFICE);
      }
    } catch {
      try {
        gameWs?.terminate();
      } catch {
        /* ignore */
      }
    }

    try {
      ai.quit?.();
    } catch {
      /* ignore */
    }
    try {
      if (producer) await producer.close();
    } catch {
      /* ignore */
    }
    try {
      sfuSocket.disconnect();
    } catch {
      /* ignore */
    }

    process.exit(0);
  };

  process.once("SIGINT", () => void cleanup());
  process.once("SIGTERM", () => void cleanup());

  debug("dj: streaming audio as guest. Press Ctrl+C to stop.");
  if (DEBUG) {
    debug(
      "dj: audio",
      WEBRTC_AUDIO_FRAMES,
      "frames → WebRTC;",
      PORTAUDIO_FRAMES_PER_BUFFER,
      "frames PortAudio (DJ_PORTAUDIO_BUFFER_MULTIPLIER=" + PORTAUDIO_BUFFER_MULTIPLIER + ")"
    );
  }
  ai.start();
}
