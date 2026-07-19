import { describe, it, expect } from "vitest";
import { JsonRpcStdioConnection } from "../src/codex/jsonrpc-stdio.js";
import { FakeAppServer, type FakeAppServerOptions } from "../src/codex/fake-app-server.js";
import { CodexAppServerClient } from "../src/codex/client.js";
import { CodexAppServerDriver } from "../src/codex/driver.js";
import type { RuntimeEvent } from "../src/runtime/driver.js";
import { parseWakePacket } from "../src/protocol/wake-packet.js";
import { dmWakePacket } from "./fixtures/wake-packets.js";

async function makeDriver(opts: FakeAppServerOptions = {}) {
  let client!: JsonRpcStdioConnection;
  const serverConn = new JsonRpcStdioConnection({ write: (l) => client.receive(l) });
  client = new JsonRpcStdioConnection({ write: (l) => serverConn.receive(l) });
  new FakeAppServer(opts).attach(serverConn);
  const codex = new CodexAppServerClient(client);
  await codex.initialize({ name: "mingle-runtime", version: "0" });
  return new CodexAppServerDriver({ client: codex });
}

async function collect(stream: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe("CodexAppServerDriver", () => {
  it("declares codex kind + capabilities (approvals, resume)", async () => {
    const d = await makeDriver();
    expect(d.kind).toBe("codex");
    expect(d.capabilities.approvals).toBe(true);
    expect(d.capabilities.resume).toBe(true);
  });

  it("maps a turn's notifications to RuntimeEvents", async () => {
    const d = await makeDriver({ reply: "嗨！" });
    const session = await d.openSession({ bindingId: "b1", scopeKey: "dm:p1" });
    expect(session.ref.providerSessionId).toMatch(/^thr_/);

    const events = await collect(d.runTurn({ session, packet: parseWakePacket(dmWakePacket) }));
    expect(events[0]?.type).toBe("turn.started");
    const delta = events.find((e) => e.type === "assistant.delta");
    expect((delta as any)?.text).toBe("嗨！");
    const done = events.at(-1);
    expect(done?.type).toBe("turn.completed");
    expect((done as any).text).toBe("嗨！");
  });

  it("surfaces a scripted approval as approval.requested and can approve it", async () => {
    const d = await makeDriver({ script: "approval-then-complete", reply: "done" });
    const session = await d.openSession({ bindingId: "b1", scopeKey: "dm:p1" });

    const events: RuntimeEvent[] = [];
    for await (const ev of d.runTurn({ session, packet: parseWakePacket(dmWakePacket) })) {
      events.push(ev);
      if (ev.type === "approval.requested") {
        await d.approve({ turnId: ev.turnId, approvalId: ev.approvalId, approved: true });
      }
    }
    expect(events.map((e) => e.type)).toContain("approval.requested");
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  it("maps a failed turn to turn.failed", async () => {
    const d = await makeDriver({ script: "fail" });
    const session = await d.openSession({ bindingId: "b1", scopeKey: "dm:p1" });
    const events = await collect(d.runTurn({ session, packet: parseWakePacket(dmWakePacket) }));
    expect(events.at(-1)?.type).toBe("turn.failed");
  });

  it("resumes an existing thread ref", async () => {
    const d = await makeDriver();
    const opened = await d.openSession({ bindingId: "b1", scopeKey: "dm:p1" });
    const resumed = await d.resumeSession(opened.ref);
    expect(resumed.ref.providerSessionId).toBe(opened.ref.providerSessionId);
  });

  it("gives two scopes two distinct threads (isolation, §5.4/§13.2)", async () => {
    const d = await makeDriver();
    const a = await d.openSession({ bindingId: "b1", scopeKey: "dm:p1" });
    const b = await d.openSession({ bindingId: "b1", scopeKey: "channel:c9" });
    expect(a.ref.providerSessionId).not.toBe(b.ref.providerSessionId);
  });
});
