import { describe, it, expect } from "vitest";
import { spawnWorkBuddyAcp, codebuddyAvailable } from "../src/workbuddy/spawn.js";
import { WorkBuddyAcpClient } from "../src/workbuddy/client.js";

/** Real gate only when a runnable codebuddy exists (CLI on PATH or embedded in
 *  WorkBuddy.app); else skip LOUDLY. */
const available = codebuddyAvailable();
if (!available) {
  console.warn("[workbuddy-smoke] SKIPPED: no runnable codebuddy (CLI on PATH or WorkBuddy.app) — install + log in to run the real gate.");
}
const maybe = available ? it : it.skip;

describe("WorkBuddy ACP smoke (real codebuddy --acp)", () => {
  maybe("initializes + opens a session", async () => {
    const server = spawnWorkBuddyAcp();
    try {
      const client = new WorkBuddyAcpClient(server.connection);
      const caps = await client.initialize({ name: "mingle-runtime-smoke", version: "0" });
      expect(typeof caps.loadSession).toBe("boolean");
      const { sessionId } = await client.sessionNew({});
      expect(sessionId).toBeTruthy();
    } finally {
      server.stop();
    }
  }, 60_000);
});
