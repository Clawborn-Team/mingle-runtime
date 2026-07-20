import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { startImServer, provisionUser, createLocalAgent, sendDm, repliesFrom, type RunningServer } from "../support/im-server.js";
import { startRuntime } from "../../src/runtime/factory.js";
import { codebuddyAvailable } from "../../src/workbuddy/spawn.js";
import type { RuntimeConfig } from "../../src/install/config.js";
import type { DaemonHandle } from "../../src/runtime/daemon.js";

/**
 * FULL-CHAIN end-to-end over BOTH a real im-server (Docker Postgres :5433) AND a real
 * codebuddy (embedded in WorkBuddy.app): owner DMs a workbuddy Local Agent → im-server
 * emits a dm.message.created wake → the real `startRuntime` daemon (factory spawns
 * `codebuddy --acp`, drives one turn through WorkBuddyAcpDriver) → the reply is
 * delivered back through the real messages API → owner reads it.
 *
 * This is the coverage the driver/consumer smoke tests can't give: the factory launch
 * path + daemon consumer loop + Event Center long-poll + real delivery, all wired.
 * Gated on a runnable codebuddy (skips the whole suite when absent, so im-server isn't
 * even booted); requires the workspace Docker Postgres like the other integration test.
 */
const available = codebuddyAvailable();
if (!available) {
  console.warn("[workbuddy-e2e] SKIPPED: no runnable codebuddy (CLI on PATH or WorkBuddy.app).");
}

describe.skipIf(!available)("workbuddy full daemon ↔ real im-server (integration)", () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await startImServer();
  }, 45_000);
  afterAll(async () => {
    await server?.stop();
  });

  it("owner DM → workbuddy Local Agent (real codebuddy) → reply delivered back to owner", async () => {
    const tag = Date.now().toString(36);
    const owner = await provisionUser(server.url, `wbown_${tag}`);
    const agent = await createLocalAgent(server.url, owner.apiKey, `wbagt_${tag}`, "workbuddy");

    // Queue the wake BEFORE the daemon starts — the first long-poll returns it at once.
    await sendDm(server.url, owner.apiKey, agent.accountId, "Reply with exactly one short word so I know you're alive.");

    const config: RuntimeConfig = {
      bindings: [{
        agentId: agent.accountId,
        key: agent.apiKey,
        imUrl: server.url,
        runtimeKind: "workbuddy",
        consumerId: `wb-e2e-${agent.accountId}`,
      }],
    };
    // Short poll wait so stop() returns promptly; digest off (no ambient turns here).
    const handle: DaemonHandle = await startRuntime(config, {
      registryPath: join(tmpdir(), `wb-e2e-${tag}.db`),
      wait: 2000,
      digestMs: 0,
    });

    try {
      // Poll the thread until the agent's reply lands (a real model turn takes seconds).
      let replies: string[] = [];
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        replies = await repliesFrom(server.url, owner.apiKey, agent.accountId, agent.accountId);
        if (replies.some((r) => r.trim().length > 0)) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      expect(replies.some((r) => r.trim().length > 0)).toBe(true);
    } finally {
      await handle.stop();
    }
  }, 120_000);

  it("YOLO tool turn: DM asks the agent to write a file → it lands in the binding workspace (bypass, no hang)", async () => {
    const tag = Date.now().toString(36);
    const owner = await provisionUser(server.url, `wbown2_${tag}`);
    const agent = await createLocalAgent(server.url, owner.apiKey, `wbagt2_${tag}`, "workbuddy");
    // The binding workspace: codebuddy's tools operate in the PROCESS cwd = this dir.
    const workspace = mkdtempSync(join(tmpdir(), `wb-ws-${tag}-`));
    const proof = join(workspace, "mingle-proof.txt");

    await sendDm(
      server.url,
      owner.apiKey,
      agent.accountId,
      "Create a file named mingle-proof.txt in your current working directory containing exactly the text: mingle-ok",
    );

    const config: RuntimeConfig = {
      bindings: [{
        agentId: agent.accountId,
        key: agent.apiKey,
        imUrl: server.url,
        runtimeKind: "workbuddy",
        dir: workspace,
        consumerId: `wb-e2e-tool-${agent.accountId}`,
      }],
    };
    const handle: DaemonHandle = await startRuntime(config, {
      registryPath: join(tmpdir(), `wb-e2e-tool-${tag}.db`),
      wait: 2000,
      digestMs: 0,
    });

    try {
      // The agent must, without any permission prompt (bypass) blocking it, run its
      // Write tool in the binding workspace. Poll for the file to appear.
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if (existsSync(proof)) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      expect(existsSync(proof)).toBe(true);
      expect(readFileSync(proof, "utf8")).toContain("mingle-ok");
    } finally {
      await handle.stop();
    }
  }, 120_000);
});
