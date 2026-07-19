import { describe, it, expect } from "vitest";
import { runBindingOnce, type EventCenterClient, type UpdatesResult, type Binding } from "../src/runtime/consumer.js";
import { InMemorySessionRegistry } from "../src/runtime/session-registry.js";
import { FakeDriver } from "../src/runtime/fake-driver.js";
import { dmWakePacket } from "./fixtures/wake-packets.js";

function fakeIm(batches: UpdatesResult[]) {
  const queue = [...batches];
  const acked: string[] = [];
  const nacked: { id: string; reason: string }[] = [];
  const sent: { to: string; body: string }[] = [];
  const im: EventCenterClient & { acked: string[]; nacked: typeof nacked; sent: typeof sent } = {
    acked,
    nacked,
    sent,
    async getUpdates() {
      return queue.shift() ?? { events: [] };
    },
    async ack(ids) {
      acked.push(...ids);
    },
    async nack(id, reason) {
      nacked.push({ id, reason });
    },
    async sendDm(to, body) {
      sent.push({ to, body });
      return { ok: true, status: 201 };
    },
    async postToChannel() {
      return { ok: true, status: 201 };
    },
  };
  return im;
}

const binding: Binding = { bindingId: "b1", agentAccountId: "a1", ownerAccountId: "o1", runtimeKind: "codex" };

describe("runBindingOnce NACK/backoff discipline (P0-3 carry-forward)", () => {
  it("NACKs a transiently-failing turn instead of ACKing it (no message loss)", async () => {
    const registry = new InMemorySessionRegistry();
    // A driver whose turn emits turn.failed → transient failure.
    const driver = new FakeDriver({ script: "approval-then-fail" });
    const im = fakeIm([{ events: [{ id: "e1", packet: dmWakePacket }], next_cursor: "c2" }]);

    await runBindingOnce({ binding, driver, registry, imClient: im });

    // the failed wake was NACKed for backoff, NOT acked
    expect(im.nacked.map((n) => n.id)).toEqual(["e1"]);
    expect(im.acked).not.toContain("e1");
  });

  it("stops draining the batch after a NACK (don't ACK past the gap)", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ script: "approval-then-fail" });
    const im = fakeIm([
      { events: [
        { id: "e1", packet: dmWakePacket },
        { id: "e2", packet: dmWakePacket },
      ] },
    ]);

    await runBindingOnce({ binding, driver, registry, imClient: im });

    expect(im.nacked.map((n) => n.id)).toEqual(["e1"]);
    // e2 stays pending (unacked, unnacked) for redelivery
    expect(im.acked).toEqual([]);
    expect(im.nacked.map((n) => n.id)).not.toContain("e2");
  });

  it("drops + ACKs a non-Mingle / unparseable packet (safe, not a NACK)", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver();
    const im = fakeIm([{ events: [{ id: "e9", packet: { schema: "not.mingle" } }] }]);

    await runBindingOnce({ binding, driver, registry, imClient: im });

    expect(im.acked).toEqual(["e9"]);
    expect(im.nacked).toEqual([]);
  });

  it("ACKs a successful turn as before", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ reply: "ok" });
    const im = fakeIm([{ events: [{ id: "e1", packet: dmWakePacket }] }]);

    await runBindingOnce({ binding, driver, registry, imClient: im });
    expect(im.acked).toEqual(["e1"]);
    expect(im.nacked).toEqual([]);
  });
});
