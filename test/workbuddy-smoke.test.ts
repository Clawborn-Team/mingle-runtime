import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { spawnWorkBuddyAcp } from "../src/workbuddy/spawn.js";
import { WorkBuddyAcpClient } from "../src/workbuddy/client.js";

/** Real gate only when codebuddy is installed + on PATH; else skip LOUDLY. */
function codebuddyAvailable(): boolean {
  try {
    execFileSync("codebuddy", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    console.warn("[workbuddy-smoke] SKIPPED: `codebuddy` not on PATH — install + log in to run the real gate.");
    return false;
  }
}
const maybe = codebuddyAvailable() ? it : it.skip;

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
