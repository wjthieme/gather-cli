/**
 * Interactive Google OAuth login for Gather v2.
 * Opens the browser with Gather's registered redirect_uri; after sign-in the user
 * is redirected to Gather's URL. User pastes that URL here so we can extract auth code,
 * then exchange it through Gather's custom-token flow used by voice/SFU auth.
 *
 * Usage: yarn start login <spaceId-or-spaceUrl>
 */
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as readline from "node:readline";
import {
  GATHER_API_BASE,
  FIREBASE_API_KEY,
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_REDIRECT_URI,
  parseSpaceIdFromGatherUrl,
} from "../utility/config.js";
import { loadCredentials, getValidJwt, writeRefreshToken } from "../utility/auth.js";
import { debug } from "../utility/debug.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export async function runLogin(spaceIdOrUrl: string): Promise<void> {
  if (!GOOGLE_OAUTH_CLIENT_ID) {
    console.error("Google OAuth client ID not configured.");
    process.exit(1);
  }
  const spaceId = parseSpaceIdFromGatherUrl(spaceIdOrUrl.trim());
  if (!spaceId) {
    console.error("Invalid space argument. Pass a Gather space URL or UUID space ID.");
    process.exit(1);
  }

  const nonce = randomBytes(16).toString("hex");
  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set("client_id", GOOGLE_OAUTH_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", GOOGLE_OAUTH_REDIRECT_URI);
  // Match login.har flow as closely as possible.
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "profile email");
  authUrl.searchParams.set("prompt", "select_account");
  authUrl.searchParams.set("state", JSON.stringify({ isInMicrosoftOfficeEnvironment: false }));
  // Keep nonce available for compatibility if providers include it.
  authUrl.searchParams.set("nonce", nonce);

  openBrowser(authUrl.toString());
  console.log("Opening browser to sign in with Google…");
  console.log("After signing in, you will be redirected to a Gather page.");
  console.log("Copy the FULL URL from your browser’s address bar and paste it below.\n");

  const redirect = await promptRedirectUrl();
  if (!redirect.authCode) {
    throw new Error(
      "Login requires OAuth auth code capture. Paste the callback URL containing ?code=..."
    );
  }

  // login.har flow:
  // 1) identitytoolkit accounts:signUp (anonymous) -> idToken
  // 2) api.v2/auth/google/token with Authorization: Bearer <anonymous idToken> + { authCode }
  // 3) identitytoolkit accounts:signInWithCustomToken using returned token -> refreshToken
  const bootstrapTokens: string[] = [];
  const anonymousBootstrap = await createAnonymousBootstrapIdToken();
  bootstrapTokens.push(anonymousBootstrap);

  // If user already had saved credentials, try that JWT too.
  const existing = loadCredentials();
  if (existing?.refreshToken) {
    try {
      const existingJwt = await getValidJwt(existing);
      if (existingJwt) bootstrapTokens.push(existingJwt);
    } catch {
      /* ignore */
    }
  }

  const gatheredToken = await exchangeAuthCodeForGatherTokenWithCandidates(
    redirect.authCode,
    bootstrapTokens
  );
  const finalSession = await signInWithCustomToken(gatheredToken);
  const refreshToken = finalSession.refreshToken;
  if (!refreshToken) {
    throw new Error("Failed to exchange Gather custom token for Firebase refresh token.");
  }

  writeRefreshToken(refreshToken, spaceId);
  console.log("Credentials saved to ~/.config/gather/auth.json");
}

function promptRedirectUrl(): Promise<{ authCode: string | null }> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    rl.question("Paste the redirect URL here: ", (input) => {
      rl.close();
      const trimmed = input.trim();
      if (!trimmed) {
        reject(new Error("No URL entered"));
        return;
      }
      const parsed = parseRedirectTokens(trimmed);
      if (parsed.authCode) resolve({ authCode: parsed.authCode });
      else
        reject(
          new Error(
            "Could not find auth code in URL. Make sure you pasted the full callback URL."
          )
        );
    });
  });
}

function parseRedirectTokens(redirectUrl: string): { authCode: string | null } {
  const extractCodeFromMaybeUrl = (value: string, depth = 0): string | null => {
    if (!value || depth > 3) return null;
    try {
      const u = new URL(value);
      const direct = u.searchParams.get("code");
      if (direct) return direct;
      const hashParams = new URLSearchParams(u.hash.startsWith("#") ? u.hash.slice(1) : u.hash);
      const hashCode = hashParams.get("code");
      if (hashCode) return hashCode;
      // Some Google pages wrap callback URLs in query params.
      const wrappers = ["continue", "redirect_uri", "redirect", "next", "url"];
      for (const key of wrappers) {
        const nested = u.searchParams.get(key);
        if (!nested) continue;
        const nestedCode = extractCodeFromMaybeUrl(decodeURIComponent(nested), depth + 1);
        if (nestedCode) return nestedCode;
      }
      return null;
    } catch {
      // Fallback: raw text that still contains code=...
      const match = value.match(/[?&#]code=([^&#\s]+)/);
      return match ? decodeURIComponent(match[1]!) : null;
    }
  };

  try {
    const url = new URL(redirectUrl);
    const query = url.searchParams;
    const error = query.get("error");
    if (error) {
      const desc = query.get("error_description") ?? "";
      throw new Error(`Google OAuth: ${error} ${desc}`);
    }
    const authCode = extractCodeFromMaybeUrl(redirectUrl);
    return { authCode };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Google OAuth:")) throw err;
    return { authCode: extractCodeFromMaybeUrl(redirectUrl) };
  }
}

function summarizeJwt(token: string): {
  sub?: string;
  provider?: string;
  gatherUserAccountId?: string;
} {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as {
      sub?: string;
      firebase?: { sign_in_provider?: string };
      gather?: { userAccountId?: string };
    };
    return {
      ...(payload.sub ? { sub: payload.sub } : {}),
      ...(payload.firebase?.sign_in_provider
        ? { provider: payload.firebase.sign_in_provider }
        : {}),
      ...(payload.gather?.userAccountId ? { gatherUserAccountId: payload.gather.userAccountId } : {}),
    };
  } catch {
    return {};
  }
}

async function createAnonymousBootstrapIdToken(): Promise<string> {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${encodeURIComponent(
    FIREBASE_API_KEY
  )}`;
  const body = JSON.stringify({
    returnSecureToken: true,
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firebase anonymous signUp failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { idToken?: string };
  if (!data.idToken) {
    throw new Error("Firebase anonymous signUp response missing idToken");
  }
  return data.idToken;
}

async function exchangeAuthCodeForGatherToken(authCode: string, bootstrapIdToken: string): Promise<string> {
  const url = `${GATHER_API_BASE}/auth/google/token`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bootstrapIdToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ authCode }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gather auth/google/token failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error("Gather auth/google/token response missing token");
  return data.token;
}

async function exchangeAuthCodeForGatherTokenWithCandidates(
  authCode: string,
  bootstrapTokens: string[]
): Promise<string> {
  let lastError: unknown = null;
  const unique = [...new Set(bootstrapTokens.filter(Boolean))];
  for (let i = 0; i < unique.length; i++) {
    const token = unique[i]!;
    const tokenInfo = summarizeJwt(token);
    debug(
      `login: trying auth/google/token with bootstrap token #${i + 1}/${unique.length}`,
      JSON.stringify(tokenInfo)
    );
    try {
      return await exchangeAuthCodeForGatherToken(authCode, token);
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      debug(`login: auth/google/token failed for bootstrap token #${i + 1}: ${message}`);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Could not exchange auth code for Gather token with available bootstrap tokens");
}

async function signInWithCustomToken(
  customToken: string
): Promise<{ refreshToken: string | null; idToken: string | null }> {
  const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(
    FIREBASE_API_KEY
  )}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  if (!res.ok) return { refreshToken: null, idToken: null };
  const data = (await res.json()) as { refreshToken?: string; idToken?: string };
  return {
    refreshToken: data.refreshToken ?? null,
    idToken: data.idToken ?? null,
  };
}

function openBrowser(url: string): void {
  let cmd: string;
  switch (process.platform) {
    case "darwin":
      cmd = "open";
      break;
    case "win32":
      cmd = "start";
      break;
    default:
      cmd = "xdg-open";
      break;
  }
  exec(`${cmd} "${url}"`, () => {});
}
