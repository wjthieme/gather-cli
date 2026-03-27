import WebSocket from "ws";
import { ensureLoggedIn, type GatherCredentials } from "../utility/auth.js";
import { getNowPlayingWithPosition } from "../utility/apple-music.js";
import {
  createGatherConnection,
  sendBroadcastMessage,
  validateAccountMatch,
} from "../utility/gather-ws.js";
import { debug } from "../utility/debug.js";

const POLL_MS = 1000;
const DRIFT_THRESHOLD_SEC = 0.5;
const LRCLIB_SEARCH_URL = "https://lrclib.net/api/search";

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

function normalizeLyricLines(lyrics: string): string[] {
  return lyrics
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function lyricLineForPosition(lines: string[], positionSec: number, durationSec: number): string | null {
  if (lines.length === 0 || durationSec <= 0) return null;
  const ratio = Math.min(1, Math.max(0, positionSec / durationSec));
  const idx = Math.min(lines.length - 1, Math.floor(ratio * lines.length));
  return lines[idx] ?? null;
}

interface TimedLyricLine {
  timeSec: number;
  text: string;
}

function parseSyncedLrc(lrc: string): TimedLyricLine[] {
  const out: TimedLyricLine[] = [];
  const lines = lrc.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/);
    if (!match) continue;
    const min = Number.parseInt(match[1] ?? "0", 10);
    const sec = Number.parseFloat(match[2] ?? "0");
    const text = (match[3] ?? "").trim();
    if (!Number.isFinite(min) || !Number.isFinite(sec) || !text) continue;
    out.push({ timeSec: min * 60 + sec, text });
  }
  return out.sort((a, b) => a.timeSec - b.timeSec);
}

function lyricLineForTimedPosition(lines: TimedLyricLine[], positionSec: number): string | null {
  if (lines.length === 0) return null;
  let selected: TimedLyricLine | null = null;
  for (const line of lines) {
    if (line.timeSec <= positionSec) selected = line;
    else break;
  }
  return selected?.text ?? lines[0]?.text ?? null;
}

interface ScheduledLyricLine {
  id: number;
  timeSec: number;
  text: string;
}

interface LyricsFetchResult {
  timed: TimedLyricLine[];
  plain: string[];
}

function buildScheduledLines(
  timed: TimedLyricLine[],
  plain: string[],
  durationSec: number
): ScheduledLyricLine[] {
  if (timed.length > 0) {
    return timed.map((line, index) => ({ id: index, timeSec: line.timeSec, text: line.text }));
  }
  if (plain.length === 0 || durationSec <= 0) return [];
  const out: ScheduledLyricLine[] = [];
  const step = durationSec / Math.max(plain.length, 1);
  for (let i = 0; i < plain.length; i++) {
    out.push({ id: i, timeSec: i * step, text: plain[i]! });
  }
  return out;
}

function indexForTimedPosition(lines: ScheduledLyricLine[], positionSec: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.timeSec <= positionSec) idx = i;
    else break;
  }
  return idx;
}

async function fetchFallbackLyrics(
  artist: string,
  title: string
): Promise<{ timed: TimedLyricLine[]; plain: string[] }> {
  const url = new URL(LRCLIB_SEARCH_URL);
  url.searchParams.set("artist_name", artist);
  url.searchParams.set("track_name", title);

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`lrclib search failed (${res.status})`);
  }

  const data = (await res.json()) as Array<{ syncedLyrics?: string; plainLyrics?: string }>;
  for (const row of data) {
    const synced = typeof row.syncedLyrics === "string" ? row.syncedLyrics : "";
    const plain = typeof row.plainLyrics === "string" ? row.plainLyrics : "";
    const timed = synced ? parseSyncedLrc(synced) : [];
    const plainLines = plain ? normalizeLyricLines(plain) : [];
    if (timed.length > 0 || plainLines.length > 0) {
      return { timed, plain: plainLines };
    }
  }
  return { timed: [], plain: [] };
}

export async function runLyrics(): Promise<void> {
  const creds = await ensureCredentials();
  const spaceUserId = getSpaceUserIdFromState(creds);
  if (!spaceUserId) {
    console.error("Missing spaceUserId. Run: yarn start login (after entering your space once).");
    process.exit(1);
  }

  let ws: WebSocket | null = null;
  // Populated from WebSocket state snapshots/patches (all known space users).
  const knownSpaceUserIds = new Set<string>();
  let activeTrackKey: string | null = null;
  /** Last track the poller observed; used to drop lyric loads superseded by a newer track. */
  let desiredTrackKey: string | null = null;
  /** Prevents overlapping startTrack() for the same track while prefetch is in flight. */
  let loadingTrackKey: string | null = null;
  let activeTrackArtist = "";
  let activeTrackTitle = "";
  let activeScheduledLines: ScheduledLyricLine[] = [];
  let activeSentLineIds = new Set<number>();
  let activeStartPositionSec = 0;
  let activeStartWallMs = 0;
  let activePaused = true;
  let timer: NodeJS.Timeout | null = null;
  const lyricsPrefetch = new Map<string, Promise<LyricsFetchResult>>();

  const clearSchedule = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const prefetchTrackLyrics = (artist: string, title: string): Promise<LyricsFetchResult> => {
    const trackKey = `${artist}::${title}`;
    const existing = lyricsPrefetch.get(trackKey);
    if (existing) return existing;
    const fetchPromise = fetchFallbackLyrics(artist, title)
      .then((result) => {
        debug(
          `lyrics: prefetched "${title}" by "${artist}" (timed=${result.timed.length}, plain=${result.plain.length})`
        );
        return result;
      })
      .catch((err) => {
        // Don't keep a rejected promise in cache; allow retry on next poll.
        lyricsPrefetch.delete(trackKey);
        throw err;
      });
    lyricsPrefetch.set(trackKey, fetchPromise);
    return fetchPromise;
  };

  const getEstimatedPositionSec = (): number =>
    activeStartPositionSec + (Date.now() - activeStartWallMs) / 1000;

  const ensureConnected = async (): Promise<WebSocket> => {
    await validateAccountMatch(creds);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      ws?.terminate();
      ws = await createGatherConnection(
        creds,
        () => {
          ws = null;
        },
        (ids) => {
          knownSpaceUserIds.clear();
          for (const id of ids) knownSpaceUserIds.add(id);
        }
      );
    }
    return ws;
  };

  const sendLyricLine = async (line: ScheduledLyricLine, positionSec: number): Promise<void> => {
    if (activeSentLineIds.has(line.id)) return;
    try {
      const socket = await ensureConnected();
      sendBroadcastMessage(socket, spaceUserId, line.text, [...knownSpaceUserIds]);
      activeSentLineIds.add(line.id);
      debug(`lyrics: "${activeTrackTitle}" @ ${positionSec.toFixed(1)}s -> ${line.text}`);
    } catch (err) {
      console.warn("Lyrics send error:", err);
      ws?.terminate();
      ws = null;
    }
  };

  const scheduleNext = async (): Promise<void> => {
    clearSchedule();
    if (activePaused || activeScheduledLines.length === 0) return;

    const nowPos = getEstimatedPositionSec();
    const previousIdx = indexForTimedPosition(activeScheduledLines, nowPos);
    if (previousIdx >= 0) {
      const previous = activeScheduledLines[previousIdx]!;
      if (!activeSentLineIds.has(previous.id)) {
        await sendLyricLine(previous, nowPos);
      }
    }

    const next = activeScheduledLines.find(
      (line) => line.timeSec > nowPos && !activeSentLineIds.has(line.id)
    );
    if (!next) return;

    const delayMs = Math.max(0, Math.round((next.timeSec - nowPos) * 1000));
    timer = setTimeout(() => {
      void sendLyricLine(next, next.timeSec).then(() => scheduleNext());
    }, delayMs);
  };

  const startTrack = async (
    artist: string,
    title: string,
    positionSec: number,
    durationSec: number
  ): Promise<void> => {
    const trackKey = `${artist}::${title}`;
    try {
      const result = await prefetchTrackLyrics(artist, title);
      const scheduled = buildScheduledLines(result.timed, result.plain, durationSec);
      if (desiredTrackKey !== trackKey) {
        debug(`lyrics: stale load skipped "${title}" (wanted ${desiredTrackKey ?? "?"})`);
        return;
      }
      activeTrackKey = trackKey;
      activeTrackArtist = artist;
      activeTrackTitle = title;
      activeScheduledLines = scheduled;
      activeSentLineIds = new Set<number>();
      activeStartPositionSec = positionSec;
      activeStartWallMs = Date.now();
      activePaused = false;
      debug(
        `lyrics: loaded "${title}" by "${artist}" (timed=${result.timed.length}, plain=${result.plain.length}, scheduled=${scheduled.length})`
      );
      await scheduleNext();
    } catch (err) {
      debug("lyrics: fetch failed", err);
    }
  };

  const pollState = async () => {
    const nowPlaying = getNowPlayingWithPosition();
    if (!nowPlaying) {
      if (!activePaused) {
        activePaused = true;
        clearSchedule();
        debug("lyrics: paused");
      }
      return;
    }

    const trackKey = `${nowPlaying.artist}::${nowPlaying.title}`;
    desiredTrackKey = trackKey;
    // Kick off lyric fetch as soon as we observe track metadata.
    void prefetchTrackLyrics(nowPlaying.artist, nowPlaying.title).catch((err) => {
      debug("lyrics: prefetch failed", err);
    });

    if (trackKey !== activeTrackKey) {
      if (loadingTrackKey === trackKey) return;
      const loadKey = trackKey;
      loadingTrackKey = loadKey;
      clearSchedule();
      try {
        await startTrack(
          nowPlaying.artist,
          nowPlaying.title,
          nowPlaying.positionSec,
          nowPlaying.durationSec
        );
      } finally {
        if (loadingTrackKey === loadKey) loadingTrackKey = null;
      }
      return;
    }

    if (activePaused) {
      activePaused = false;
      activeStartPositionSec = nowPlaying.positionSec;
      activeStartWallMs = Date.now();
      await scheduleNext();
      return;
    }

    // If the user scrubs or drift becomes large, re-anchor schedule clock.
    const estimated = getEstimatedPositionSec();
    if (Math.abs(estimated - nowPlaying.positionSec) > DRIFT_THRESHOLD_SEC) {
      activeStartPositionSec = nowPlaying.positionSec;
      activeStartWallMs = Date.now();
      await scheduleNext();
    }
  };

  await pollState();
  setInterval(() => {
    void pollState();
  }, POLL_MS);
}
