/**
 * Interactive Google OAuth login for Gather v2.
 * Opens the browser with Gather's registered redirect_uri; after sign-in the user
 * is redirected to Gather's URL. User pastes that URL here so we can extract the
 * id_token and exchange it for a Firebase refresh token.
 *
 * Usage: yarn start login [spaceId-or-spaceUrl]
 */
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as readline from "node:readline";
import {
  FIREBASE_API_KEY,
  FIREBASE_IDENTITYTOOLKIT_URL,
  GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_REDIRECT_URI,
  GOOGLE_OAUTH_SCOPE,
  parseSpaceIdFromGatherUrl,
} from "../utility/config.js";
import { writeRefreshToken, writeSpaceId } from "../utility/auth.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

export async function runLogin(spaceIdOrUrl?: string): Promise<void> {
  if (!GOOGLE_OAUTH_CLIENT_ID) {
    console.error("Google OAuth client ID not configured.");
    process.exit(1);
  }

  const nonce = randomBytes(16).toString("hex");
  const authUrl = new URL(GOOGLE_AUTH_URL);
  authUrl.searchParams.set("client_id", GOOGLE_OAUTH_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", GOOGLE_OAUTH_REDIRECT_URI);
  authUrl.searchParams.set("response_type", "id_token");
  authUrl.searchParams.set("scope", GOOGLE_OAUTH_SCOPE);
  authUrl.searchParams.set("nonce", nonce);

  openBrowser(authUrl.toString());
  console.log("Opening browser to sign in with Google…");
  console.log("After signing in, you will be redirected to a Gather page.");
  console.log("Copy the FULL URL from your browser’s address bar and paste it below.\n");

  const idToken = await promptRedirectUrl();
  const refreshToken = await exchangeIdTokenForRefreshToken(idToken);
  writeRefreshToken(refreshToken);
  console.log("Refresh token saved to .auth");

  if (spaceIdOrUrl?.trim()) {
    const spaceId = parseSpaceIdFromGatherUrl(spaceIdOrUrl.trim());
    if (spaceId) {
      writeSpaceId(spaceId);
      console.log("Space ID saved to .auth (second line).");
    }
  }
}

function promptRedirectUrl(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve, reject) => {
    rl.question("Paste the redirect URL here: ", (input) => {
      rl.close();
      const trimmed = input.trim();
      if (!trimmed) {
        reject(new Error("No URL entered"));
        return;
      }
      const idToken = parseIdTokenFromRedirectUrl(trimmed);
      if (idToken) resolve(idToken);
      else reject(new Error("Could not find id_token in the URL. Make sure you pasted the full URL including the # part."));
    });
  });
}

function parseIdTokenFromRedirectUrl(redirectUrl: string): string | null {
  try {
    const url = new URL(redirectUrl);
    const hash = url.hash.slice(1);
    if (!hash) return null;
    const params = new URLSearchParams(hash);
    const error = params.get("error");
    if (error) {
      const desc = params.get("error_description") ?? "";
      throw new Error(`Google OAuth: ${error} ${desc}`);
    }
    return params.get("id_token");
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Google OAuth:")) throw err;
    return null;
  }
}

async function exchangeIdTokenForRefreshToken(googleIdToken: string): Promise<string> {
  const url = `${FIREBASE_IDENTITYTOOLKIT_URL}?key=${encodeURIComponent(FIREBASE_API_KEY)}`;
  const body = JSON.stringify({
    requestUri: GOOGLE_OAUTH_REDIRECT_URI,
    returnSecureToken: true,
    postBody: `id_token=${encodeURIComponent(googleIdToken)}&providerId=google.com`,
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Firebase signInWithIdp failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as { refreshToken?: string };
  if (!data.refreshToken) {
    throw new Error("Firebase response missing refreshToken");
  }
  return data.refreshToken;
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
