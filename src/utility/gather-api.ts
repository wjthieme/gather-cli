/**
 * Gather v2 REST API helpers (reverse‑engineered from HAR).
 * - GET /api/v2/users/me?spaceId= → userAccount.firebaseAuthId (authUserId)
 * - GET /api/v2/spaces/:spaceId/users/me/base-calendar-events (msgpack) → spaceUserId
 * No endpoint in the HAR returns the user's space_id; it only appears in request paths. Pass spaceId as CLI arg.
 */
import { decode } from "@msgpack/msgpack";
import { GATHER_API_BASE } from "./config.js";

export async function fetchMe(jwt: string): Promise<{ authUserId: string }> {
  const url = `${GATHER_API_BASE}/users/me?spaceId=`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gather users/me failed (${res.status}): ${text}`);
  }
  const data = (await res.json()) as {
    userAccount?: { firebaseAuthId?: string };
  };
  const authUserId = data.userAccount?.firebaseAuthId;
  if (!authUserId) {
    throw new Error("Gather users/me response missing userAccount.firebaseAuthId");
  }
  return { authUserId };
}

function findSpaceUserIdInObject(obj: unknown): string | null {
  if (obj && typeof obj === "object" && "spaceUserId" in obj) {
    const v = (obj as { spaceUserId?: unknown }).spaceUserId;
    if (typeof v === "string") return v;
  }
  if (obj && typeof obj === "object") {
    for (const v of Object.values(obj)) {
      const found = findSpaceUserIdInObject(v);
      if (found) return found;
    }
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findSpaceUserIdInObject(item);
      if (found) return found;
    }
  }
  return null;
}

export async function fetchSpaceUserId(jwt: string, spaceId: string): Promise<string> {
  const url = `${GATHER_API_BASE}/spaces/${spaceId}/users/me/base-calendar-events`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/json, application/x.gather.msgpack",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gather base-calendar-events failed (${res.status}): ${text}`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  const buf = new Uint8Array(await res.arrayBuffer());
  if (contentType.includes("msgpack") || buf.length > 0) {
    try {
      const decoded = decode(buf);
      const spaceUserId = findSpaceUserIdInObject(decoded);
      if (spaceUserId) return spaceUserId;
    } catch {
      // fallback: regex on raw text (msgpack decoded to utf8 may contain the uuid)
      const str = new TextDecoder().decode(buf);
      const match = str.match(/spaceUserId[^a-f0-9-]*([a-f0-9-]{36})/i);
      if (match) return match[1];
    }
  }
  throw new Error("Could not find spaceUserId in Gather base-calendar-events response");
}
