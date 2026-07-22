import { describe, it, expect } from "vitest";
import { processWake, type EventCenterClient, type Binding } from "../src/runtime/consumer.js";
import { InMemorySessionRegistry } from "../src/runtime/session-registry.js";
import { FakeDriver } from "../src/runtime/fake-driver.js";
import { buildWakePacket } from "../src/protocol/wake-adapter.js";
import { dmRawEvent, ownerContextRefreshRawEvent } from "./fixtures/wake-packets.js";

function fakeIm(): EventCenterClient & { commits: number; dms: unknown[] } {
  const dms: unknown[] = [];
  let commits = 0;
  return {
    dms,
    get commits() {
      return commits;
    },
    async getUpdates() {
      return { events: [] };
    },
    async ack() {},
    async nack() {},
    async sendDm(to, body) {
      dms.push({ to, body });
      return { ok: true, status: 201 };
    },
    async postToChannel() {
      return { ok: true, status: 201 };
    },
    async commitOwnerContext() {
      commits += 1;
    },
  } as EventCenterClient & { commits: number; dms: unknown[] };
}

const binding: Binding = { bindingId: "b1", agentAccountId: "a1", ownerAccountId: "owner1", runtimeKind: "codex" };

describe("owner-context commit fires only on delivered refresh", () => {
  it("commits the window fingerprint after a delivered owner-context report", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ reply: JSON.stringify({ schema_version: "owner-context-v1", material_change: true }) });
    const im = fakeIm();
    const packet = buildWakePacket({ account_id: "a1", agent_kind: "local" }, { kind: "event", event: ownerContextRefreshRawEvent }, [], "t");

    const result = await processWake({ packet, binding, driver, registry, imClient: im });

    expect(result.delivery).toBe("delivered");
    expect(im.commits).toBe(1);
  });

  it("does NOT commit when the owner-context turn produced no deliverable report", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ reply: "" }); // no final report → nothing delivered
    const im = fakeIm();
    const packet = buildWakePacket({ account_id: "a1", agent_kind: "local" }, { kind: "event", event: ownerContextRefreshRawEvent }, [], "t");

    await processWake({ packet, binding, driver, registry, imClient: im });

    expect(im.commits).toBe(0);
  });

  it("does NOT commit for an ordinary (non owner-context) delivered DM", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ reply: "hi there" });
    const im = fakeIm();
    const packet = buildWakePacket({ account_id: "a1", agent_kind: "local" }, { kind: "event", event: dmRawEvent }, [], "t");

    const result = await processWake({ packet, binding, driver, registry, imClient: im });

    expect(result.delivery).toBe("delivered");
    expect(im.commits).toBe(0);
  });
});
