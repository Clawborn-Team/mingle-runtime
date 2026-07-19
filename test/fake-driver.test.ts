import { describe, it, expect } from "vitest";
import { FakeDriver } from "../src/runtime/fake-driver.js";
import type { RuntimeEvent } from "../src/runtime/driver.js";
import { parseWakePacket } from "../src/protocol/wake-packet.js";
import { dmWakePacket } from "./fixtures/wake-packets.js";

async function collect(stream: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe("FakeDriver", () => {
  it("declares its kind + capabilities", () => {
    const d = new FakeDriver();
    expect(d.kind).toBe("codex");
    expect(d.capabilities.streaming).toBe(true);
  });

  it("opens a session and streams turn.started → assistant.delta → turn.completed", async () => {
    const d = new FakeDriver({ reply: "嗨！" });
    const session = await d.openSession({ bindingId: "b1", scopeKey: "dm:p1" });
    expect(session.ref.providerSessionId).toMatch(/^fake-/);

    const packet = parseWakePacket(dmWakePacket);
    const events = await collect(d.runTurn({ session, packet }));
    expect(events.map((e) => e.type)).toEqual(["turn.started", "assistant.delta", "turn.completed"]);
    const completed = events.at(-1);
    expect(completed?.type).toBe("turn.completed");
    expect((completed as { text?: string }).text).toBe("嗨！");
  });

  it("resumes the same providerSessionId", async () => {
    const d = new FakeDriver();
    const opened = await d.openSession({ bindingId: "b1", scopeKey: "dm:p1" });
    const resumed = await d.resumeSession(opened.ref);
    expect(resumed.ref.providerSessionId).toBe(opened.ref.providerSessionId);
  });

  it("records approvals and interrupts for assertion", async () => {
    const d = new FakeDriver();
    await d.approve({ turnId: "t1", approvalId: "a1", approved: true });
    await d.interrupt("t1");
    expect(d.approvals).toEqual([{ turnId: "t1", approvalId: "a1", approved: true }]);
    expect(d.interrupts).toEqual(["t1"]);
  });

  it("can be scripted to emit an approval.requested then fail", async () => {
    const d = new FakeDriver({ script: "approval-then-fail" });
    const session = await d.openSession({ bindingId: "b1", scopeKey: "dm:p1" });
    const events = await collect(d.runTurn({ session, packet: parseWakePacket(dmWakePacket) }));
    expect(events.map((e) => e.type)).toEqual(["turn.started", "approval.requested", "turn.failed"]);
  });
});
