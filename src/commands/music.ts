/**
 * Gather v2 music status: every 5s get Apple Music track, refresh JWT if needed,
 * connect to game-router.v2 WebSocket, authenticate, and set custom status (or clear).
 */
import WebSocket from "ws";
import { decode } from "@msgpack/msgpack";
import { ensureLoggedIn, type GatherCredentials } from "../utility/auth.js";
import {
  createGatherConnection,
  sendSetCustomStatus,
  sendClearStatus,
  validateAccountMatch,
} from "../utility/gather-ws.js";
import { getNowPlaying } from "../utility/apple-music.js";
import { debug, DEBUG } from "../utility/debug.js";

const INTERVAL_MS = 5000;
const MUSIC_EMOJI = "🎵";

function getSpaceUserIdFromState(creds: GatherCredentials): string | null {
  return creds.spaceUserId ?? null;
}

async function ensureCredentials(): Promise<GatherCredentials> {
  const creds = await ensureLoggedIn();
  if (!creds.spaceId || !creds.authUserId) {
    console.error("Missing spaceId or authUserId. Run: yarn start login");
    process.exit(1);
  }
  return creds;
}

export async function runMusic(): Promise<void> {
  const creds = await ensureCredentials();
  const spaceUserId = getSpaceUserIdFromState(creds);
  if (!spaceUserId) {
    console.error("Missing spaceUserId. Run: yarn start login (after setting/clearing status in the space).");
    process.exit(1);
  }

  let ws: WebSocket | null = null;
  let lastStatus: string | null = null;
  let pendingStatusTxnId: string | null = null;

  const tick = async () => {
    debug("--- tick ---");
    if (pendingStatusTxnId !== null) {
      console.warn("Previous status update may have failed (no DeltaState received for txn " + pendingStatusTxnId.slice(0, 8) + ")");
      pendingStatusTxnId = null;
      lastStatus = null;
    }
    const nowPlaying = getNowPlaying();
    debug(
      "Apple Music:",
      nowPlaying
        ? `"${nowPlaying.title}" · "${nowPlaying.artist}"`
        : "nothing playing / paused"
    );
    const statusText = nowPlaying
      ? `${nowPlaying.title} · ${nowPlaying.artist}`.trim() || nowPlaying.title
      : null;

    if (statusText === lastStatus) {
      debug("skip: status unchanged");
      return;
    }
    lastStatus = statusText;
    debug("new status:", statusText ?? "(clear)");

    await validateAccountMatch(creds);

    try {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        debug("ws: not open, opening...");
        ws?.terminate();
        ws = await createGatherConnection(creds, () => {
          ws = null;
        });
        const onMessage = (data: Buffer | ArrayBuffer) => {
          try {
            const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as Buffer);
            const msg = decode(buf) as { type?: string };
            if (msg?.type === "DeltaState") {
              pendingStatusTxnId = null;
              if (DEBUG) debug("ws: DeltaState (status update confirmed)");
            }
          } catch {
            /* ignore */
          }
        };
        ws.on("message", onMessage);
      } else {
        debug("ws: reusing existing connection");
      }

      if (statusText) {
        pendingStatusTxnId = sendSetCustomStatus(ws, spaceUserId, statusText, MUSIC_EMOJI);
      } else {
        pendingStatusTxnId = sendClearStatus(ws, spaceUserId);
      }
    } catch (err) {
      console.warn("Tick error:", err);
      debug("tick error detail:", err);
      ws?.terminate();
      ws = null;
    }
  };

  const cleanup = async () => {
    try {
      if (ws?.readyState === WebSocket.OPEN && spaceUserId) {
        sendClearStatus(ws, spaceUserId);
        await new Promise((r) => setTimeout(r, 300));
      }
    } catch {
      /* ignore */
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => {
    void cleanup();
  });

  await tick();
  setInterval(tick, INTERVAL_MS);
}
