import { describe, it, expect } from "vitest";
import { processWake, runBindingOnce, type EventCenterClient, type UpdatesResult } from "../src/runtime/consumer.js";
import { InMemorySessionRegistry } from "../src/runtime/session-registry.js";
import { FakeDriver } from "../src/runtime/fake-driver.js";
import { parseWakePacket } from "../src/protocol/wake-packet.js";
import { dmWakePacket, dmRawEvent, unknownRawEvent } from "./fixtures/wake-packets.js";

/** A scripted Event Center client: yields the queued update batches, records ACKs + sent DMs. */
function fakeImClient(batches: UpdatesResult[]): EventCenterClient & { acked: string[]; sent: { to: string; body: string }[] } {
  const queue = [...batches];
  const acked: string[] = [];
  const sent: { to: string; body: string }[] = [];
  return {
    acked,
    sent,
    async getUpdates() {
      return queue.shift() ?? { events: [] };
    },
    async ack(ids) {
      acked.push(...ids);
    },
    async nack() {
      /* not exercised in these happy-path tests */
    },
    async sendDm(to, body) {
      sent.push({ to, body });
      return { ok: true, status: 201 };
    },
    async postToChannel() {
      return { ok: true, status: 201 };
    },
  };
}

const binding = { bindingId: "b1", agentAccountId: "a1", ownerAccountId: "o1", runtimeKind: "codex" as const };

describe("processWake", () => {
  it("opens a session for a new scope, runs a turn, delivers the reply", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ reply: "嗨！" });
    const im = fakeImClient([]);
    const packet = parseWakePacket(dmWakePacket);

    const result = await processWake({ packet, binding, driver, registry, imClient: im });

    expect(result.scopeKey).toBe("dm:p1");
    expect(result.events.map((e) => e.type)).toContain("turn.completed");
    // reply delivered to the dm reply target
    expect(im.sent).toEqual([{ to: "p1", body: "嗨！" }]);
    // session recorded for reuse
    expect((await registry.get("b1", "dm:p1"))?.providerSessionId).toBeTruthy();
    expect(driver.openedScopes).toEqual(["dm:p1"]);
  });

  it("RESUMES the same scope on a second wake (no new session)", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver();
    const im = fakeImClient([]);
    const packet = parseWakePacket(dmWakePacket);

    await processWake({ packet, binding, driver, registry, imClient: im });
    const first = (await registry.get("b1", "dm:p1"))?.providerSessionId;
    await processWake({ packet, binding, driver, registry, imClient: im });
    const second = (await registry.get("b1", "dm:p1"))?.providerSessionId;

    expect(second).toBe(first);
    // openSession called exactly once — the second wake resumed
    expect(driver.openedScopes).toEqual(["dm:p1"]);
  });
});

describe("runBindingOnce", () => {
  it("drains one update batch, handles each wake, and ACKs every event", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ reply: "hi" });
    const im = fakeImClient([
      { events: [dmRawEvent], next_cursor: "c2" },
    ]);

    const cursor = await runBindingOnce({ binding, driver, registry, imClient: im });

    expect(im.acked).toEqual(["e1"]);
    expect(im.sent).toEqual([{ to: "p1", body: "hi" }]);
    expect(cursor).toBe("c2");
  });

  it("ACKs a non-actionable event without a turn", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver();
    // An unknown/non-wake event type derives no conversation → dropped + ACKed,
    // never driving a turn (forward-compatible).
    const im = fakeImClient([{ events: [unknownRawEvent] }]);

    await runBindingOnce({ binding, driver, registry, imClient: im });
    expect(im.acked).toEqual(["e_unknown"]);
    expect(im.sent).toEqual([]);
  });
});
