/**
 * Gather v2 REST API helpers (reverse‑engineered from HAR).
 * - GET /api/v2/users/me?spaceId= → userAccount.firebaseAuthId (authUserId)
 * - Same response may include **token**: Gather **Firebase custom token** (JWT with adminsdk `iss`) for Identity Toolkit
 *   `accounts:signInWithCustomToken` — that yields the **client** `id_token` with `gather.*` (guest2.har). **router.v2** `auth.token`
 *   is that client id_token, not this custom token string. First `users/me?spaceId=` may include `token`; later calls may omit it.
 *   Body is sometimes **base64-encoded JSON**.
 * - GET /api/v2/spaces/:spaceId/users/me/base-calendar-events (msgpack) → spaceUserId
 * No endpoint in the HAR returns the user's space_id; it only appears in request paths. Pass spaceId as CLI arg.
 */
import { decode } from "@msgpack/msgpack";
import { debug } from "./debug.js";
import { GATHER_API_BASE, GATHER_APP_ORIGIN } from "./config.js";

/**
 * Load the guest `/join` page as the browser does — may prime cookies/session or edge rules
 * so check-in prompts can be routed to `copierid`. Best-effort; ignores non-2xx.
 */
export async function primeGuestJoinPage(jwt: string, joinUrl: string): Promise<void> {
  try {
    const res = await fetch(joinUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        Origin: GATHER_APP_ORIGIN,
        Referer: `${GATHER_APP_ORIGIN}/`,
      },
      redirect: "follow",
    });
    debug("gather: primeGuestJoinPage", res.status, joinUrl.slice(0, 80));
  } catch (err) {
    debug("gather: primeGuestJoinPage error", err);
  }
}

/** guest2.har: `users/me` body is base64(JSON); sometimes a normal JSON object. */
function parseUsersMeBody(raw: string): {
  userAccount?: { firebaseAuthId?: string; id?: string };
  token?: string;
} {
  const trimmed = raw.replace(/^\uFEFF/, "").trim();
  if (!trimmed) {
    throw new Error("Gather users/me empty body");
  }
  let data: unknown;
  if (trimmed.startsWith("{")) {
    data = JSON.parse(trimmed) as unknown;
  } else {
    data = JSON.parse(Buffer.from(trimmed, "base64").toString("utf8")) as unknown;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Gather users/me parsed value is not a JSON object");
  }
  return data as { userAccount?: { firebaseAuthId?: string; id?: string }; token?: string };
}

export async function fetchMe(
  jwt: string,
  spaceId?: string
): Promise<{ authUserId: string; userAccountId?: string; spaceToken?: string }> {
  const url = `${GATHER_API_BASE}/users/me?spaceId=${encodeURIComponent(spaceId ?? "")}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/json, text/plain, */*",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gather users/me failed (${res.status}): ${text}`);
  }
  const data = parseUsersMeBody(await res.text());
  const authUserId = data.userAccount?.firebaseAuthId;
  if (!authUserId) {
    throw new Error("Gather users/me response missing userAccount.firebaseAuthId");
  }
  const userAccountId =
    typeof data.userAccount?.id === "string" && data.userAccount.id.trim()
      ? data.userAccount.id
      : undefined;
  const spaceToken = typeof data.token === "string" && data.token.trim() ? data.token : undefined;
  return {
    authUserId,
    ...(userAccountId ? { userAccountId } : {}),
    ...(spaceToken ? { spaceToken } : {}),
  };
}

const USER_ACCOUNT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function tryParseGatherJsonBody(raw: string): unknown | null {
  const trimmed = raw.replace(/^\uFEFF/, "").trim();
  if (!trimmed) return null;
  try {
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return JSON.parse(trimmed) as unknown;
    }
    return JSON.parse(Buffer.from(trimmed, "base64").toString("utf8")) as unknown;
  } catch {
    return null;
  }
}

/** JSON, base64 JSON, or msgpack (calendar / some `spaces/…` payloads). */
async function readGatherHttpBody(res: Response): Promise<unknown | null> {
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length === 0) return null;
  if (ct.includes("msgpack") || ct.includes("x.gather.msgpack")) {
    try {
      return decode(buf) as unknown;
    } catch {
      return null;
    }
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(buf).replace(/^\uFEFF/, "").trim();
  if (text) {
    const j = tryParseGatherJsonBody(text);
    if (j !== null) return j;
  }
  try {
    return decode(buf) as unknown;
  } catch {
    return null;
  }
}

function firstUserAccountIdInObject(obj: unknown, depth = 0): string | undefined {
  if (depth > 14 || obj === null || obj === undefined) return undefined;
  if (typeof obj !== "object") return undefined;
  if (Array.isArray(obj)) {
    for (const x of obj) {
      const f = firstUserAccountIdInObject(x, depth + 1);
      if (f) return f;
    }
    return undefined;
  }
  const o = obj as Record<string, unknown>;
  if (typeof o.userAccountId === "string" && USER_ACCOUNT_UUID_RE.test(o.userAccountId.trim())) {
    return o.userAccountId.trim();
  }
  const ua = o.userAccount;
  if (ua && typeof ua === "object" && !Array.isArray(ua)) {
    const id = (ua as { id?: unknown }).id;
    if (typeof id === "string" && USER_ACCOUNT_UUID_RE.test(id.trim())) return id.trim();
  }
  for (const v of Object.values(o)) {
    const f = firstUserAccountIdInObject(v, depth + 1);
    if (f) return f;
  }
  return undefined;
}

/**
 * Resolve **SpaceUser.id** → Gather **userAccount.id** for SFU signaling (`consume-allow` dstId).
 * Tries several v2 URL shapes (not all spaces return data); **member** JWT (`yarn login`) usually works best.
 */
export async function fetchUserAccountIdForSpaceUser(
  jwt: string,
  spaceId: string,
  spaceUserId: string
): Promise<string | undefined> {
  const su = spaceUserId.trim();
  if (!USER_ACCOUNT_UUID_RE.test(su)) return undefined;
  const encSpace = encodeURIComponent(spaceId);
  const encSu = encodeURIComponent(su);
  const paths = [
    `${GATHER_API_BASE}/spaces/${encSpace}/users/${encSu}`,
    `${GATHER_API_BASE}/spaces/${encSpace}/spaceUsers/${encSu}`,
    `${GATHER_API_BASE}/spaces/${encSpace}/space-users/${encSu}`,
    `${GATHER_API_BASE}/spaces/${encSpace}/users/by-space-user-id/${encSu}`,
  ];
  for (const url of paths) {
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/json, application/x.gather.msgpack, text/plain, */*",
        },
      });
      if (!res.ok) continue;
      const parsed = await readGatherHttpBody(res);
      const id = firstUserAccountIdInObject(parsed);
      if (id) {
        debug("gather: spaceUser→userAccount", su.slice(0, 8) + "…", url.replace(GATHER_API_BASE, ""));
        return id;
      }
    } catch {
      /* try next path */
    }
  }
  return undefined;
}

function uuidStringLooksLikeUserAccountField(key: string): boolean {
  const k = key.toLowerCase();
  if (k.includes("spaceuser")) return false;
  return (
    k.includes("useraccount") ||
    k.includes("gatheruseraccount") ||
    (k.includes("participant") && k.includes("account")) ||
    (k.endsWith("userid") && k.includes("account"))
  );
}

function collectUserAccountIdsFromJson(obj: unknown, out: Set<string>, depth = 0): void {
  if (depth > 20 || obj === null || obj === undefined) return;
  if (typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const x of obj) collectUserAccountIdsFromJson(x, out, depth + 1);
    return;
  }
  const o = obj as Record<string, unknown>;
  if (typeof o.userAccountId === "string" && USER_ACCOUNT_UUID_RE.test(o.userAccountId.trim())) {
    out.add(o.userAccountId.trim());
  }
  const ua = o.userAccount;
  if (ua && typeof ua === "object" && !Array.isArray(ua)) {
    const id = (ua as { id?: unknown }).id;
    if (typeof id === "string" && USER_ACCOUNT_UUID_RE.test(id.trim())) out.add(id.trim());
  }
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "string" && USER_ACCOUNT_UUID_RE.test(v.trim()) && uuidStringLooksLikeUserAccountField(k)) {
      out.add(v.trim());
    }
    collectUserAccountIdsFromJson(v, out, depth + 1);
  }
}

/**
 * Resolve **Firebase authUserId** (game **Connection** row) → Gather **userAccount.id** for SFU `consume-allow`.
 */
export async function fetchUserAccountIdForFirebaseAuthId(
  jwt: string,
  firebaseAuthId: string
): Promise<string | undefined> {
  const fid = firebaseAuthId.trim();
  if (fid.length < 8) return undefined;
  const enc = encodeURIComponent(fid);
  const paths = [
    `${GATHER_API_BASE}/users/${enc}`,
    `${GATHER_API_BASE}/users/by-firebase-auth-id/${enc}`,
    `${GATHER_API_BASE}/users/byFirebaseAuthId/${enc}`,
  ];
  for (const url of paths) {
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/json, application/x.gather.msgpack, text/plain, */*",
        },
      });
      if (!res.ok) continue;
      const parsed = await readGatherHttpBody(res);
      const id = firstUserAccountIdInObject(parsed);
      if (id) {
        debug("gather: firebaseAuth→userAccount", fid.slice(0, 8) + "…", url.replace(GATHER_API_BASE, ""));
        return id;
      }
    } catch {
      /* next path */
    }
  }
  return undefined;
}

/**
 * Best-effort space roster (member JWT). Unions all **userAccount** UUIDs found in JSON from several undocumented paths.
 */
export async function fetchSpaceRosterUserAccountIds(jwt: string, spaceId: string): Promise<string[]> {
  const enc = encodeURIComponent(spaceId);
  const paths = [
    `${GATHER_API_BASE}/spaces/${enc}`,
    `${GATHER_API_BASE}/spaces/${enc}/users`,
    `${GATHER_API_BASE}/spaces/${enc}/spaceUsers`,
    `${GATHER_API_BASE}/spaces/${enc}/participants`,
    `${GATHER_API_BASE}/spaces/${enc}/online-users`,
    `${GATHER_API_BASE}/spaces/${enc}/members`,
  ];
  const out = new Set<string>();
  for (const url of paths) {
    try {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/json, application/x.gather.msgpack, text/plain, */*",
        },
      });
      if (!res.ok) continue;
      const parsed = await readGatherHttpBody(res);
      const before = out.size;
      collectUserAccountIdsFromJson(parsed, out);
      if (out.size > before) {
        debug("gather: roster +", out.size - before, "ids from", url.replace(GATHER_API_BASE, ""));
      }
    } catch {
      /* next path */
    }
  }
  return [...out];
}

/**
 * **POST** `/api/v2/spaces/:spaceId/users/me/base-calendar-events/sync` — calendar integration for **signed-in members**
 * (dj.har: Bearer Firebase JWT, empty body → 200). Not part of anonymous guest flows; callers that need it should be member-only.
 */
export async function postBaseCalendarEventsSync(jwt: string, spaceId: string): Promise<void> {
  const url = `${GATHER_API_BASE}/spaces/${encodeURIComponent(spaceId)}/users/me/base-calendar-events/sync`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/json, */*",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gather base-calendar-events/sync failed (${res.status}): ${text}`);
  }
  await res.arrayBuffer();
  debug("gather: base-calendar-events/sync ok");
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * After a guest opens an invite link, the inviter must approve in the Gather app.
 * Until then, base-calendar-events often fails; once approved, this returns spaceUserId.
 */
export async function waitForGuestSpaceUserId(
  jwt: string,
  spaceId: string,
  options?: {
    pollMs?: number;
    timeoutMs?: number;
    onPoll?: () => void;
  }
): Promise<string> {
  const pollMs = options?.pollMs ?? 2500;
  const timeoutMs = options?.timeoutMs ?? 600_000;
  const deadline = Date.now() + timeoutMs;
  let notified = false;
  while (Date.now() < deadline) {
    try {
      return await fetchSpaceUserId(jwt, spaceId);
    } catch {
      if (!notified) {
        notified = true;
        console.log(
          "Still waiting for approval… Approve the guest in the Gather app when the prompt appears."
        );
      }
      options?.onPoll?.();
      await sleep(pollMs);
    }
  }
  throw new Error(
    "Timed out waiting for guest approval. Ask the host to approve the guest in the space."
  );
}
