/**
 * Spin starting facing Down; only emote 🌀 when facing Down, then hold 2s; repeat.
 */
import WebSocket from "ws";
import { ensureLoggedIn, type GatherCredentials } from "../utility/auth.js";
import {
  createGatherConnection,
  sendBroadcastEmote,
  sendFaceDirection,
  FACE_DIRECTIONS,
} from "../utility/gather-ws.js";
import { debug } from "../utility/debug.js";

const SPIN_EMOJI = "🌀";
const SPIN_STEP_MS = 400;
const EMOTE_HOLD_MS = 2000;
/** Start facing Down, then Left, Up, Right (cycle back to Down). */
const SPIN_ORDER: (typeof FACE_DIRECTIONS)[number][] = ["Down", "Left", "Up", "Right"];

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runSpin(): Promise<void> {
  const creds = await ensureCredentials();
  const spaceUserId = getSpaceUserIdFromState(creds);
  if (!spaceUserId) {
    console.error("Missing spaceUserId. Run: yarn start login (and open your space once).");
    process.exit(1);
  }

  let ws: WebSocket | null = null;

  const ensureConnection = async (): Promise<WebSocket> => {
    if (ws?.readyState === WebSocket.OPEN) return ws;
    debug("ws: connecting...");
    ws?.terminate();
    ws = await createGatherConnection(creds, () => {
      ws = null;
    });
    return ws;
  };

  const loop = async () => {
    try {
      await ensureConnection();
      for (const direction of SPIN_ORDER) {
        if (!ws || ws.readyState !== WebSocket.OPEN) await ensureConnection();
        sendFaceDirection(ws!, spaceUserId, direction);
        if (direction === "Down") {
          sendBroadcastEmote(ws!, spaceUserId, SPIN_EMOJI);
          await sleep(EMOTE_HOLD_MS);
        } else {
          await sleep(SPIN_STEP_MS);
        }
      }
    } catch (err) {
      console.warn("Spin step error:", err);
      ws?.terminate();
      ws = null;
    }
    setTimeout(loop, 0);
  };

  loop();
}
