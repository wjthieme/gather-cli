import fs from "node:fs";
import { AUTH_DIR, AUTH_FILE, FIREBASE_API_KEY, FIREBASE_TOKEN_URL } from "./config.js";
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
  /**
   * From `GET /users/me?spaceId=…` when present: Gather **Firebase custom token** (exchange via Identity Toolkit
   * `accounts:signInWithCustomToken` → new `id_token` with `gather.*`; guest2.har). Not sent to router.v2 as `auth.token`.
   */
  gatherSpaceSessionToken?: string;
  /** Cached JWT (in-memory only) */
  accessToken?: string;
  /** Expiry time for accessToken (in-memory only) */
  accessTokenExpiresAt?: number;
}

interface AuthFileData {
  refreshToken?: string;
  spaceId?: string;
}

function ensureAuthFileExists(): void {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
  if (!fs.existsSync(AUTH_FILE)) {
    fs.writeFileSync(AUTH_FILE, "{}\n", "utf-8");
  }
}

/** Read credentials from auth.json. */
export function loadCredentials(): GatherCredentials | null {
  try {
    ensureAuthFileExists();
    const raw = fs.readFileSync(AUTH_FILE, "utf-8");
    const parsed = JSON.parse(raw) as AuthFileData;
    const refreshToken = typeof parsed.refreshToken === "string" ? parsed.refreshToken : "";
    if (!refreshToken) return null;
    const spaceId = typeof parsed.spaceId === "string" && parsed.spaceId ? parsed.spaceId : undefined;
    return {
      refreshToken,
      ...(spaceId ? { spaceId } : {}),
    };
  } catch {
    return null;
  }
}

/** Write refresh token to auth.json. If spaceId is provided, writes it too. */
export function writeRefreshToken(refreshToken: string, spaceId?: string): void {
  ensureAuthFileExists();
  const data: AuthFileData = {
    refreshToken,
    ...(spaceId ? { spaceId } : {}),
  };
  fs.writeFileSync(AUTH_FILE, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

/** Append or update spaceId in auth.json. Preserves refreshToken. */
export function writeSpaceId(spaceId: string): void {
  const creds = loadCredentials();
  if (!creds?.refreshToken) {
    throw new Error("No refresh token in auth file; run yarn start login first");
  }
  const data: AuthFileData = {
    refreshToken: creds.refreshToken,
    spaceId,
  };
  fs.writeFileSync(AUTH_FILE, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

/**
 * guest2.har: after first `GET /users/me` with the anonymous `id_token`, the client POSTs Gather's `token` field here.
 * That returns a **new** `id_token` + `refresh_token` where the JWT includes `gather.userAccountId` (custom sign-in).
 * Securetoken **refresh** alone does not add those claims — it only reissues for the current sign-in provider.
 */
export async function signInWithGatherCustomToken(creds: GatherCredentials, customToken: string): Promise<void> {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(
    FIREBASE_API_KEY
  )}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firebase signInWithCustomToken failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as {
    idToken?: string;
    refreshToken?: string;
    expiresIn?: string;
  };
  if (!data.idToken || !data.refreshToken) {
    throw new Error("Firebase signInWithCustomToken response missing idToken or refreshToken");
  }
  creds.accessToken = data.idToken;
  creds.refreshToken = data.refreshToken;
  const expiresIn = Number(data.expiresIn);
  creds.accessTokenExpiresAt = Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000;
  debug("auth: signInWithCustomToken (Gather users/me.token → id_token with gather claims)");
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

function getFirebaseUidFromIdToken(idToken: string): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")
    ) as { sub?: string; user_id?: string };
    const uid = payload.user_id ?? payload.sub;
    return typeof uid === "string" && uid.trim() ? uid : null;
  } catch {
    return null;
  }
}

/**
 * Firebase anonymous session for a Gather **guest** (not written to auth.json).
 * guest.har shows `GET users/me` with `userAccount.email: null` for this pattern.
 */
export async function createAnonymousGuestSession(spaceId: string): Promise<GatherCredentials> {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(
    FIREBASE_API_KEY
  )}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firebase anonymous signUp (guest) failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as {
    idToken?: string;
    refreshToken?: string;
    expiresIn?: string;
  };
  if (!data.idToken || !data.refreshToken) {
    throw new Error("Firebase anonymous signUp response missing idToken or refreshToken");
  }
  const jwtUid = getFirebaseUidFromIdToken(data.idToken);
  const meBoot = await fetchMe(data.idToken, spaceId);
  const { authUserId } = meBoot;
  if (jwtUid && jwtUid !== authUserId) {
    debug("auth: guest JWT sub/user_id ≠ users/me firebaseAuthId; using API for WS + Connection match", {
      jwtUid,
      authUserId,
    });
  }
  const expiresIn = Number(data.expiresIn);
  const creds: GatherCredentials = {
    refreshToken: data.refreshToken,
    spaceId,
    authUserId,
    accessToken: data.idToken,
    accessTokenExpiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000,
    ...(meBoot.spaceToken ? { gatherSpaceSessionToken: meBoot.spaceToken } : {}),
  };
  if (meBoot.spaceToken) {
    await signInWithGatherCustomToken(creds, meBoot.spaceToken);
  }
  return creds;
}

const LOGIN_INSTRUCTIONS = `
No refresh token found. Run:  yarn start login

During login you can paste your Gather space URL (from the address bar when in a space);
the CLI will remember it so you can run  yarn start music  or  yarn start dance  without arguments.
`;

/** Ensures we have credentials; fetches authUserId and spaceUserId from the API. Uses spaceId from auth file or CLI arg. */
export async function ensureLoggedIn(spaceIdFromArg?: string): Promise<GatherCredentials> {
  const creds = loadCredentials();
  if (!creds?.refreshToken) {
    console.error(LOGIN_INSTRUCTIONS);
    process.exit(1);
  }
  const spaceId = spaceIdFromArg ?? creds.spaceId;
  if (!spaceId) {
    console.error(
      "Space ID not set. Run  yarn start login  and paste your Gather space URL when prompted, or add a spaceId value in ~/.config/gather/auth.json"
    );
    process.exit(1);
  }
  creds.spaceId = spaceId;
  const jwt = await getValidJwt(creds);
  if (!creds.authUserId) {
    const { authUserId } = await fetchMe(jwt, creds.spaceId);
    creds.authUserId = authUserId;
    debug("auth: fetched authUserId from API");
  }
  if (!creds.spaceUserId) {
    creds.spaceUserId = await fetchSpaceUserId(jwt, creds.spaceId);
    debug("auth: fetched spaceUserId from API");
  }
  return creds;
}
