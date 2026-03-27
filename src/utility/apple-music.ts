import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

export interface NowPlaying {
  artist: string;
  title: string;
  playing: boolean;
}

export interface NowPlayingWithPosition extends NowPlaying {
  positionSec: number;
  durationSec: number;
}

const APPLESCRIPT = `tell application "Music"
if player state is stopped or player state is paused then return "STATE:PAUSED"
try
  set t to current track
  set trackName to name of t
  set trackArtist to artist of t
  set trackDuration to duration of t
  set playPos to player position
  if trackName is missing value then set trackName to ""
  if trackArtist is missing value then set trackArtist to ""
  if trackDuration is missing value then set trackDuration to 0
  if playPos is missing value then set playPos to 0
  return "STATE:PLAYING" & linefeed & "ARTIST:" & trackArtist & linefeed & "TITLE:" & trackName & linefeed & "POS:" & playPos & linefeed & "DURATION:" & trackDuration
on error
  return "STATE:PAUSED"
end try
end tell
`;

function runAppleScript(script: string, fileTag: string): string {
  const tmp = path.join(tmpdir(), `${fileTag}-${process.pid}.applescript`);
  try {
    fs.writeFileSync(tmp, script, "utf8");
    return execSync(`osascript "${tmp}"`, {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    }).trim();
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function parseNowPlayingOutput(out: string): NowPlayingWithPosition | null {
  if (!out.startsWith("STATE:PLAYING")) return null;

  const lines = out.split("\n");
  const artistLine = lines.find((line) => line.startsWith("ARTIST:")) ?? "ARTIST:";
  const titleLine = lines.find((line) => line.startsWith("TITLE:")) ?? "TITLE:";
  const posLine = lines.find((line) => line.startsWith("POS:")) ?? "POS:0";
  const durationLine = lines.find((line) => line.startsWith("DURATION:")) ?? "DURATION:0";

  const artist = artistLine.slice("ARTIST:".length).trim();
  const title = titleLine.slice("TITLE:".length).trim();
  const positionSec = Number.parseFloat(posLine.slice("POS:".length).trim()) || 0;
  const durationSec = Number.parseFloat(durationLine.slice("DURATION:".length).trim()) || 0;

  if (!artist && !title) return null;
  return {
    artist,
    title,
    playing: true,
    positionSec,
    durationSec,
  };
}

/**
 * Gets current Apple Music track and play state via AppleScript.
 * Returns null if nothing playing or paused/stopped.
 */
export function getNowPlaying(): NowPlaying | null {
  try {
    const out = runAppleScript(APPLESCRIPT, "music-status");
    const parsed = parseNowPlayingOutput(out);
    if (!parsed) return null;
    return { artist: parsed.artist, title: parsed.title, playing: true };
  } catch {
    return null;
  }
}

/**
 * Gets current Apple Music track with position and duration.
 * Does not request lyrics from Apple Music.
 */
export function getNowPlayingWithPosition(): NowPlayingWithPosition | null {
  try {
    const out = runAppleScript(APPLESCRIPT, "music-position");
    return parseNowPlayingOutput(out);
  } catch {
    return null;
  }
}

/** Gather display names longer than this are truncated (server/UI limits vary). */
const GATHER_DISPLAY_NAME_MAX_LEN = 96;

export function truncateGatherDisplayName(name: string): string {
  const t = name.trim();
  if (t.length <= GATHER_DISPLAY_NAME_MAX_LEN) return t;
  return t.slice(0, GATHER_DISPLAY_NAME_MAX_LEN);
}

/**
 * **`"title - artist"`** for Gather UI (e.g. **`setCustomStatus`**), or **`title`** only when artist is empty.
 * **`null`** when not playing, unavailable, or not macOS (uses **`getNowPlaying()`** / same AppleScript as other helpers).
 */
export function getAppleMusicNowPlayingDisplayName(): string | null {
  if (process.platform !== "darwin") return null;
  const np = getNowPlaying();
  if (!np) return null;
  const title = np.title.trim();
  if (!title) return null;
  const artist = np.artist.trim();
  return artist ? `${title} - ${artist}` : title;
}
