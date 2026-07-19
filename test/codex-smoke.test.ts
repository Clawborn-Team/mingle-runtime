import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { spawnCodexAppServer } from "../src/codex/spawn.js";
import { CodexAppServerClient } from "../src/codex/client.js";

/** Only run when a real `codex` binary is on PATH; else skip (CI/dev without it). */
function codexAvailable(): boolean {
  try {
    execFileSync("codex", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const maybe = codexAvailable() ? it : it.skip;

describe("Codex App Server smoke (real binary)", () => {
  maybe("initializes + starts a thread against real codex app-server", async () => {
    const server = spawnCodexAppServer();
    try {
      const client = new CodexAppServerClient(server.connection);
      await client.initialize({ name: "mingle-runtime-smoke", version: "0" });
      const thread = await client.threadStart({ approvalPolicy: "never" });
      expect(thread.threadId).toBeTruthy();
    } finally {
      server.stop();
    }
  }, 30_000);
});
