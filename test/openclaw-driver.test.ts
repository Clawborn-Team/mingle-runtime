import { describe, it, expect } from "vitest";
import { OpenClawDriver } from "../src/openclaw/driver.js";
import { FakeGateway } from "../src/openclaw/gateway.js";
import type { RuntimeEvent } from "../src/runtime/driver.js";
import { parseWakePacket } from "../src/protocol/wake-packet.js";
import { dmWakePacket, channelMentionWakePacket, heartbeatWithNotificationsPacket } from "./fixtures/wake-packets.js";

async function collect(stream: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe("OpenClawDriver (spec §5.6 — Gateway adapter, not CLI-scraper)", () => {
  it("declares openclaw kind + capabilities (resume, tools)", () => {
    const d = new OpenClawDriver({ gateway: new FakeGateway() });
    expect(d.kind).toBe("openclaw");
    expect(d.capabilities.resume).toBe(true);
    expect(d.capabilities.tools).toBe(true);
  });

  it("opens a gateway session keyed by scope_key", async () => {
    const gateway = new FakeGateway();
    const d = new OpenClawDriver({ gateway });
    const session = await d.openSession({ bindingId: "b1", scopeKey: "dm:p1" });
    expect(session.ref.providerSessionId).toBeTruthy();
    expect(gateway.openedKeys).toContain("dm:p1");
  });

  it("runs a turn: feeds the SHARED structured wake to the gateway, maps reply → events", async () => {
    const gateway = new FakeGateway({ reply: "嗨！" });
    const d = new OpenClawDriver({ gateway });
    const session = await d.openSession({ bindingId: "b1", scopeKey: "dm:p1" });
    const events = await collect(d.runTurn({ session, packet: parseWakePacket(dmWakePacket) }));

    expect(events[0]?.type).toBe("turn.started");
    expect(events.find((e) => e.type === "assistant.delta")).toBeTruthy();
    const done = events.at(-1);
    expect(done?.type).toBe("turn.completed");
    expect((done as any).text).toBe("嗨！");

    // the gateway received the FULL structured wake (P1-5), not just the body
    expect(gateway.lastInput).toContain("dm.message.created");
    expect(gateway.lastInput).toContain("hi 小龙");
    expect(gateway.lastInput).not.toBe("hi 小龙");
  });

  it("feeds channel scope + heartbeat context through the same renderer", async () => {
    const gateway = new FakeGateway();
    const d = new OpenClawDriver({ gateway });
    const ch = await d.openSession({ bindingId: "b1", scopeKey: "channel:ch9" });
    await collect(d.runTurn({ session: ch, packet: parseWakePacket(channelMentionWakePacket) }));
    expect(gateway.lastInput).toContain("channel:ch9");

    const hb = await d.openSession({ bindingId: "b1", scopeKey: "owner:o1" });
    await collect(d.runTurn({ session: hb, packet: parseWakePacket(heartbeatWithNotificationsPacket) }));
    expect(gateway.lastInput).not.toBe("(heartbeat)");
    expect(gateway.lastInput).toContain("找搭子");
  });

  it("maps a gateway failure to turn.failed", async () => {
    const gateway = new FakeGateway({ fail: true });
    const d = new OpenClawDriver({ gateway });
    const session = await d.openSession({ bindingId: "b1", scopeKey: "dm:p1" });
    const events = await collect(d.runTurn({ session, packet: parseWakePacket(dmWakePacket) }));
    expect(events.at(-1)?.type).toBe("turn.failed");
  });

  it("resumes the same gateway session on a second wake (isolation across scopes)", async () => {
    const gateway = new FakeGateway();
    const d = new OpenClawDriver({ gateway });
    const a = await d.openSession({ bindingId: "b1", scopeKey: "dm:p1" });
    const b = await d.openSession({ bindingId: "b1", scopeKey: "channel:c9" });
    expect(a.ref.providerSessionId).not.toBe(b.ref.providerSessionId);

    const resumed = await d.resumeSession(a.ref);
    expect(resumed.ref.providerSessionId).toBe(a.ref.providerSessionId);
  });
});
