import path from "node:path";
import os from "node:os";

/** JSON auth file with refreshToken and optional spaceId. */
export const AUTH_DIR = path.join(os.homedir(), ".config", "gather");
export const AUTH_FILE = path.join(AUTH_DIR, "auth.json");

/** Extract space ID from Gather app URL (e.g. app.v2.gather.town/app/orca-d6d6a364-a19f-4e01-92c2-da74c8ecb6be). */
const SPACE_ID_IN_URL = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;
export function parseSpaceIdFromGatherUrl(urlOrPath: string): string | null {
  const match = urlOrPath.match(SPACE_ID_IN_URL);
  return match ? match[0]! : null;
}

/** Gather v2 REST API base (reverse‑engineered from HAR). No endpoint in HAR returns the user's space_id; it only appears in request paths. */
export const GATHER_API_BASE = "https://api.v2.gather.town/api/v2";

/** Gather v2 WebSocket (from your protocol analysis) */
export const GATHER_WS_URL = "wss://game-router.v2.gather.town/gather-game-v2";

/** Firebase token refresh (Gather v2 uses Firebase Auth). Override key via GATHER_V2_FIREBASE_API_KEY. */
export const FIREBASE_TOKEN_URL = "https://securetoken.googleapis.com/v1/token";
export const FIREBASE_API_KEY = "AIzaSyDPwTbXLMPbIkg6UKr49VrHWwkrOdRh__E";

/** Firebase identitytoolkit (for signInWithIdp). */
export const FIREBASE_IDENTITYTOOLKIT_URL =
  "https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp";

/** Google OAuth for interactive login (from Gather login HAR). */
export const GOOGLE_OAUTH_CLIENT_ID =
  "384507832813-a4kih5nnq730movqlpcofkooovg9ip4f.apps.googleusercontent.com";
/** Must match the redirect URI registered for GOOGLE_OAUTH_CLIENT_ID (Gather's callback). */
export const GOOGLE_OAUTH_REDIRECT_URI =
  "https://api.v2.gather.town/auth/signin/google/callback";
export const GOOGLE_OAUTH_SCOPE = "openid email profile";
