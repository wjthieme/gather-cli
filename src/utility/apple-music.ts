import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";

export interface NowPlaying {
  artist: string;
  title: string;
  playing: boolean;
}

const APPLESCRIPT = `tell application "Music"
if player state is stopped or player state is paused then return "PAUSED|"
try
  set t to current track
  set trackName to name of t
  set trackArtist to artist of t
  if trackName is missing value then set trackName to ""
  if trackArtist is missing value then set trackArtist to ""
  return "PLAYING|" & trackArtist & "|" & trackName
on error
  return "PAUSED|"
end try
end tell
`;

/**
 * Gets current Apple Music track and play state via AppleScript.
 * Returns null if nothing playing or paused/stopped.
 */
export function getNowPlaying(): NowPlaying | null {
  const tmp = path.join(tmpdir(), `music-status-${process.pid}.applescript`);
  try {
    fs.writeFileSync(tmp, APPLESCRIPT, "utf8");
    const out = execSync(`osascript "${tmp}"`, {
      encoding: "utf-8",
      maxBuffer: 4096,
    }).trim();
    const [state, artist = "", title = ""] = out.split("|");
    if (state !== "PLAYING" || (!artist && !title)) return null;
    return { artist: artist.trim(), title: title.trim(), playing: true };
  } catch {
    return null;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}
