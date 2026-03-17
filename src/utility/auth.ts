import fs from "node:fs";
import { AUTH_FILE, FIREBASE_API_KEY, FIREBASE_TOKEN_URL } from "./config.js";
import { debug } from "./debug.js";
import { fetchMe, fetchSpaceUserId } from "./gather-api.js";

export interface GatherCredentials {
  refreshToken: string;
  /** Fetched from API when needed (in-memory only) */
  spaceId?: string;
  /** Fetched from API (in-memory only) */
  authUserId?: string;
  /** Fetched from API (in-memory only) */
  spaceUserId?: string;
  /** Cached JWT (in-memory only) */
  accessToken?: string;
  /** Expiry time for accessToken (in-memory only) */
  accessTokenExpiresAt?: number;
}

/** Read credentials from .auth: line 1 = refresh token, line 2 = space ID (optional). */
export function loadCredentials(): GatherCredentials | null {
  try {
    const raw = fs.readFileSync(AUTH_FILE, "utf-8");
    const lines = raw.split(/\r?\n/).map((s) => s.trim());
    const refreshToken = lines[0];
    if (!refreshToken) return null;
    const spaceId = lines[1] || undefined;
    return { refreshToken, ...(spaceId ? { spaceId } : {}) };
  } catch {
    return null;
  }
}

/** Write refresh token to .auth (line 1). If spaceId is provided, writes it as line 2. */
export function writeRefreshToken(refreshToken: string, spaceId?: string): void {
  const content = spaceId ? `${refreshToken}\n${spaceId}\n` : `${refreshToken}\n`;
  fs.writeFileSync(AUTH_FILE, content, "utf-8");
}

/** Append or update space ID (line 2) in .auth. Preserves existing line 1. */
export function writeSpaceId(spaceId: string): void {
  const creds = loadCredentials();
  if (!creds?.refreshToken) {
    throw new Error("No refresh token in .auth; run yarn start login first");
  }
  fs.writeFileSync(AUTH_FILE, `${creds.refreshToken}\n${spaceId}\n`, "utf-8");
}

/** Refresh the id_token (JWT) using Firebase securetoken. Gather v2 uses Firebase Auth (issuer securetoken.google.com/gather-town-v2). */
export async function refreshBearerToken(creds: GatherCredentials): Promise<string> {
  debug("auth: refreshing JWT via Firebase securetoken");
  const url = `${FIREBASE_TOKEN_URL}?key=${encodeURIComponent(FIREBASE_API_KEY)}`;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: creds.refreshToken,
  }).toString();
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firebase token refresh failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as {
    id_token?: string;
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  };
  const token = data.id_token ?? data.access_token;
  if (!token) throw new Error("Firebase refresh response had no id_token");
  creds.accessToken = token;
  if (typeof data.expires_in === "number")
    creds.accessTokenExpiresAt = Date.now() + data.expires_in * 1000;
  if (data.refresh_token) creds.refreshToken = data.refresh_token;
  debug("auth: JWT refreshed, expires_in:", data.expires_in);
  return token;
}

/** Read exp (seconds) from JWT payload; null if missing or invalid. */
function getJwtExp(token: string): number | null {
  try {
    const payload = JSON.parse(
      Buffer.from((token.split(".")[1] ?? ""), "base64url").toString("utf8")
    ) as { exp?: number };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/** Returns current valid JWT, refreshing if expired or within margin. */
export async function getValidJwt(creds: GatherCredentials): Promise<string> {
  const now = Date.now();
  const margin = 60 * 1000; // refresh 1 min before expiry

  if (creds.accessToken) {
    if (creds.accessTokenExpiresAt != null && creds.accessTokenExpiresAt > now + margin) {
      debug("auth: using cached JWT (expiresAt)");
      return creds.accessToken;
    }
    const exp = getJwtExp(creds.accessToken);
    if (exp != null && exp * 1000 > now + margin) {
      debug("auth: using cached JWT (exp claim)");
      return creds.accessToken;
    }
    debug("auth: JWT expired or missing exp, refreshing");
  }
  return refreshBearerToken(creds);
}

const LOGIN_INSTRUCTIONS = `
No refresh token found. Run:  yarn start login

During login you can paste your Gather space URL (from the address bar when in a space);
the CLI will remember it so you can run  yarn start music  or  yarn start dance  without arguments.
`;

/** Ensures we have credentials; fetches authUserId and spaceUserId from the API. Uses spaceId from .auth or CLI arg. */
export async function ensureLoggedIn(spaceIdFromArg?: string): Promise<GatherCredentials> {
  const creds = loadCredentials();
  if (!creds?.refreshToken) {
    console.error(LOGIN_INSTRUCTIONS);
    process.exit(1);
  }
  const spaceId = spaceIdFromArg ?? creds.spaceId;
  if (!spaceId) {
    console.error(
      "Space ID not set. Run  yarn start login  and paste your Gather space URL when prompted, or add the space ID as the second line of .auth"
    );
    process.exit(1);
  }
  creds.spaceId = spaceId;
  const jwt = await getValidJwt(creds);
  if (!creds.authUserId) {
    const { authUserId } = await fetchMe(jwt);
    creds.authUserId = authUserId;
    debug("auth: fetched authUserId from API");
  }
  if (!creds.spaceUserId) {
    creds.spaceUserId = await fetchSpaceUserId(jwt, creds.spaceId);
    debug("auth: fetched spaceUserId from API");
  }
  return creds;
}
