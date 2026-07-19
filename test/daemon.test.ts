import { describe, it, expect } from "vitest";
import { runBindingLoop, startDaemon, toBinding } from "../src/runtime/daemon.js";
import { runDigestOnce } from "../src/runtime/consumer.js";
import { InMemorySessionRegistry } from "../src/runtime/session-registry.js";
import { FakeDriver } from "../src/runtime/fake-driver.js";
import type { Binding, EventCenterClient, UpdatesResult } from "../src/runtime/consumer.js";
import { dmRawEvent } from "./fixtures/wake-packets.js";

const binding: Binding = { bindingId: "b1", agentAccountId: "a1", ownerAccountId: "a1", runtimeKind: "codex" };

function fakeIm(batches: UpdatesResult[]) {
  const queue = [...batches];
  const dms: { to: string; body: string }[] = [];
  const acked: string[] = [];
  let getUpdatesCalls = 0;
  const im: EventCenterClient & { dms: typeof dms; acked: string[]; getUpdatesCalls: () => number } = {
    dms,
    acked,
    getUpdatesCalls: () => getUpdatesCalls,
    async getUpdates() {
      getUpdatesCalls++;
      return queue.shift() ?? { events: [] };
    },
    async ack(ids) {
      acked.push(...ids);
    },
    async nack() {},
    async sendDm(to, body) {
      dms.push({ to, body });
      return { ok: true, status: 201 };
    },
    async postToChannel() {
      return { ok: true, status: 201 };
    },
  };
  return im;
}

describe("toBinding", () => {
  it("maps an InstalledBinding to a consumer Binding with a stable per-(agent,runtime) id", () => {
    const b = toBinding({ agentId: "agent_x", key: "k", imUrl: "https://r", runtimeKind: "claude-code", consumerId: "c" });
    expect(b).toEqual({
      bindingId: "agent_x:claude-code",
      agentAccountId: "agent_x",
      ownerAccountId: "agent_x",
      runtimeKind: "claude-code",
    });
  });
});

describe("runDigestOnce (digest heartbeat)", () => {
  it("drives a heartbeat turn (owner scope) when notifications are pending", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ reply: "noted" });
    const im = fakeIm([]);
    im.getUpdates = async () => ({
      events: [],
      notifications: [{ id: "n1", type: "channel.followup.created", payload: { summary: "3 新消息" } }],
    });
    const drove = await runDigestOnce({ binding, driver, registry, imClient: im });
    expect(drove).toBe(true);
    expect(driver.openedScopes).toEqual(["owner:a1"]); // heartbeat maps to the owner scope
    expect(im.acked).toEqual([]); // digest consumes/acks nothing — drain owns events
  });

  it("does nothing (no turn) when there are no pending notifications", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver();
    const im = fakeIm([]);
    im.getUpdates = async () => ({ events: [], notifications: [] });
    const drove = await runDigestOnce({ binding, driver, registry, imClient: im });
    expect(drove).toBe(false);
    expect(driver.openedScopes).toEqual([]);
  });
});

describe("runBindingLoop", () => {
  it("drains wakes until shouldStop, delivering + acking", async () => {
    const im = fakeIm([{ events: [dmRawEvent], next_cursor: "c2" }]);
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ reply: "hello back" });
    let ticks = 0;
    await runBindingLoop({
      binding,
      driver,
      registry,
      imClient: im,
      wait: 0,
      shouldStop: () => ++ticks > 2, // allow a couple of iterations
      sleep: async () => {},
    });
    expect(im.dms).toEqual([{ to: "p1", body: "hello back" }]);
    expect(im.acked).toContain("e1");
  });

  it("calls onError and backs off when getUpdates throws, without crashing the loop", async () => {
    let calls = 0;
    const im: EventCenterClient = {
      async getUpdates() {
        calls++;
        throw new Error("network down");
      },
      async ack() {},
      async nack() {},
      async sendDm() {
        return { ok: true, status: 201 };
      },
      async postToChannel() {
        return { ok: true, status: 201 };
      },
    };
    const errors: unknown[] = [];
    const slept: number[] = [];
    await runBindingLoop({
      binding,
      driver: new FakeDriver(),
      registry: new InMemorySessionRegistry(),
      imClient: im,
      backoffMs: 500,
      shouldStop: () => calls >= 3,
      onError: (e) => errors.push(e),
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(slept.every((ms) => ms === 500)).toBe(true);
  });
});

describe("startDaemon", () => {
  it("runs every binding's loop concurrently and stop() resolves them all", async () => {
    const registries = new Map<string, InMemorySessionRegistry>();
    const ims = new Map<string, ReturnType<typeof fakeIm>>();
    const bindings: Binding[] = [
      { bindingId: "b1", agentAccountId: "a1", ownerAccountId: "a1", runtimeKind: "codex" },
      { bindingId: "b2", agentAccountId: "a2", ownerAccountId: "a2", runtimeKind: "claude-code" },
    ];
    const handle = startDaemon({
      bindings,
      wait: 0,
      make: (b) => {
        const im = fakeIm([{ events: [{ id: `${b.bindingId}-e`, type: dmRawEvent.type, payload: dmRawEvent.payload }] }]);
        const registry = new InMemorySessionRegistry();
        ims.set(b.bindingId, im);
        registries.set(b.bindingId, registry);
        return { driver: new FakeDriver({ reply: "ok" }), registry, imClient: im };
      },
      sleep: async () => {},
    });
    // Wait deterministically until both bindings have delivered+acked (or give up).
    for (let i = 0; i < 200; i++) {
      if (ims.get("b1")?.acked.includes("b1-e") && ims.get("b2")?.acked.includes("b2-e")) break;
      await new Promise((r) => setTimeout(r, 1));
    }
    await handle.stop();
    expect(ims.get("b1")!.acked).toContain("b1-e");
    expect(ims.get("b2")!.acked).toContain("b2-e");
  });
});
