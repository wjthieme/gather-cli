/** Enable with DEBUG=1 or DEBUG=true. Logs Apple Music state, token refresh, WebSocket, and status updates. */
export const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";

export function debug(...args: unknown[]): void {
  if (DEBUG) {
    const ts = new Date().toISOString();
    console.log(`[${ts}]`, ...args);
  }
}
