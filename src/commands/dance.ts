/**
 * Walk (move) first, then emote 🎉, then wait 2s; repeat.
 */
import WebSocket from "ws";
import { ensureLoggedIn, type GatherCredentials } from "../utility/auth.js";
import {
  createGatherConnection,
  sendBroadcastEmote,
  sendFaceDirection,
  sendMove,
} from "../utility/gather-ws.js";
import { debug } from "../utility/debug.js";

const PARTY_EMOJI = "🎉";
/** Wait 0.5s after move for animation before emote. */
const MOVE_ANIMATION_MS = 500;
/** Wait 2s after each emote before the next step. */
const DANCE_INTERVAL_MS = 2000;
/** Wait after face down before emote. */
const FACE_DOWN_DELAY_MS = 200;
/** Direction 0–3 map to Up, Right, Down, Left (dance.har move format). */
const DIRECTIONS = 4;
/** 3×3 square: offset from center must be in [-GRID_RADIUS, GRID_RADIUS]. */
const GRID_RADIUS = 1;

const MIN = -GRID_RADIUS;
const MAX = GRID_RADIUS;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

/** Next (x, y) when moving in direction dir from (x, y). 0=Up, 1=Right, 2=Down, 3=Left. */
function nextPosition(x: number, y: number, dir: number): [number, number] {
  switch (dir) {
    case 0:
      return [x, y - 1];
    case 1:
      return [x + 1, y];
    case 2:
      return [x, y + 1];
    case 3:
      return [x - 1, y];
    default:
      return [x, y];
  }
}

/** Pick a random direction that keeps (x, y) within the 3×3 grid. */
function randomDirInBounds(x: number, y: number): number {
  const valid: number[] = [];
  for (let dir = 0; dir < DIRECTIONS; dir++) {
    const [nx, ny] = nextPosition(x, y, dir);
    if (nx >= MIN && nx <= MAX && ny >= MIN && ny <= MAX) valid.push(dir);
  }
  return valid[Math.floor(Math.random() * valid.length)] ?? 0;
}

export async function runDance(): Promise<void> {
  const creds = await ensureCredentials();
  const spaceUserId = getSpaceUserIdFromState(creds);
  if (!spaceUserId) {
    console.error("Missing spaceUserId. Run: yarn start login chrome.har (after setting/clearing status in the space).");
    process.exit(1);
  }

  let ws: WebSocket | null = null;
  let posX = 0;
  let posY = 0;

  const step = async () => {
    try {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        debug("ws: connecting...");
        ws?.terminate();
        ws = await createGatherConnection(creds, () => {
          ws = null;
        });
      }

      const dir = randomDirInBounds(posX, posY);
      sendMove(ws, spaceUserId, dir);
      [posX, posY] = nextPosition(posX, posY, dir);
      await sleep(MOVE_ANIMATION_MS);
      sendFaceDirection(ws, spaceUserId, "Down");
      await sleep(FACE_DOWN_DELAY_MS);
      sendBroadcastEmote(ws, spaceUserId, PARTY_EMOJI);
      debug("dance: move dir", dir);
    } catch (err) {
      console.warn("Dance step error:", err);
      ws?.terminate();
      ws = null;
    }
  };

  await step();
  setInterval(step, DANCE_INTERVAL_MS);
}
