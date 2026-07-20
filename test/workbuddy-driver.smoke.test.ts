import { describe, it, expect } from "vitest";
import { spawnWorkBuddyAcp, codebuddyAvailable } from "../src/workbuddy/spawn.js";
import { WorkBuddyAcpClient } from "../src/workbuddy/client.js";
import { WorkBuddyAcpDriver } from "../src/workbuddy/driver.js";
import { buildWakePacket } from "../src/protocol/wake-adapter.js";
import type { RuntimeEvent } from "../src/runtime/driver.js";

const available = codebuddyAvailable();
if (!available) {
  console.warn("[workbuddy-driver.smoke] SKIPPED: no runnable codebuddy (CLI on PATH or WorkBuddy.app).");
}
const maybe = available ? it : it.skip;

/** A minimal DM wake packet for agent "a1" from peer "u_bob". */
function dmWake() {
  return buildWakePacket(
    { account_id: "a1", agent_kind: "local" },
    { kind: "event", event: { id: "e1", type: "dm.message.created", payload: {
      conversation: { scope: "dm", scope_id: "u_bob", reply_target: { kind: "dm", peer_id: "u_bob" }, peer_username: "bob" },
      message: { from_username: "bob", body: "Say the single word: pong" },
    } } },
    [],
    "e1",
  );
}

describe("WorkBuddyAcpDriver smoke (real codebuddy)", () => {
  maybe("runs one turn to a non-empty reply", async () => {
    const server = spawnWorkBuddyAcp();
    try {
      const client = new WorkBuddyAcpClient(server.connection);
      const { loadSession } = await client.initialize({ name: "mingle-runtime-smoke", version: "0" });
      const driver = new WorkBuddyAcpDriver({ client, loadSession });
      const session = await driver.openSession({ bindingId: "b1", scopeKey: "dm:u_bob" });
      const events: RuntimeEvent[] = [];
      for await (const ev of driver.runTurn({ session, packet: dmWake() })) events.push(ev);
      const done = events.find((e) => e.type === "turn.completed");
      expect(done).toBeTruthy();
      expect((done as { text?: string }).text?.length).toBeGreaterThan(0);
    } finally {
      server.stop();
    }
  }, 120_000);

  maybe("resumes the same session id across a simulated restart", async () => {
    const server = spawnWorkBuddyAcp();
    try {
      const client = new WorkBuddyAcpClient(server.connection);
      const { loadSession } = await client.initialize({ name: "mingle-runtime-smoke", version: "0" });
      if (!loadSession) { console.warn("[workbuddy-driver.smoke] agent has no loadSession; resume assertion skipped."); return; }
      const driver = new WorkBuddyAcpDriver({ client, loadSession });
      const opened = await driver.openSession({ bindingId: "b1", scopeKey: "dm:u_bob" });
      const id = opened.ref.providerSessionId;
      // Simulate the daemon restarting and resuming from the persisted id.
      const resumed = await driver.resumeSession({ bindingId: "b1", scopeKey: "dm:u_bob", providerSessionId: id });
      expect(resumed.ref.providerSessionId).toBe(id);
      const events: RuntimeEvent[] = [];
      for await (const ev of driver.runTurn({ session: resumed, packet: dmWake() })) events.push(ev);
      expect(events.some((e) => e.type === "turn.completed")).toBe(true);
    } finally {
      server.stop();
    }
  }, 120_000);
});
