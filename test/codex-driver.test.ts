import { describe, it, expect } from "vitest";
import { JsonRpcStdioConnection } from "../src/codex/jsonrpc-stdio.js";
import { FakeAppServer, type FakeAppServerOptions } from "../src/codex/fake-app-server.js";
import { CodexAppServerClient } from "../src/codex/client.js";
import { CodexAppServerDriver } from "../src/codex/driver.js";
import type { RuntimeEvent } from "../src/runtime/driver.js";
import { parseWakePacket } from "../src/protocol/wake-packet.js";
import {
  dmWakePacket,
  channelMentionWakePacket,
  heartbeatWithNotificationsPacket,
} from "./fixtures/wake-packets.js";

async function makeDriver(opts: FakeAppServerOptions = {}) {
  return (await makeDriverWithServer(opts)).driver;
}

/** Also expose the FakeAppServer so tests can inspect the actual turn/start input. */
async function makeDriverWithServer(opts: FakeAppServerOptions = {}) {
  let client!: JsonRpcStdioConnection;
  const serverConn = new JsonRpcStdioConnection({ write: (l) => client.receive(l) });
  client = new JsonRpcStdioConnection({ write: (l) => serverConn.receive(l) });
  const server = new FakeAppServer(opts);
  server.attach(serverConn);
  const codex = new CodexAppServerClient(client);
  await codex.initialize({ name: "mingle-runtime", version: "0" });
  return { driver: new CodexAppServerDriver({ client: codex }), server };
}

/** Pull the text the driver actually sent as the App Server turn input. */
function turnInputText(server: FakeAppServer): string {
  const input = server.turnInputs.at(-1) as Array<{ type: string; text?: string }> | undefined;
  return (input ?? []).map((b) => b.text ?? "").join("");
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

  it("captures the reply from item/completed even when NO deltas stream (real-codex regression)", async () => {
    // A real Codex turn can deliver its final answer only via item/completed (the
    // model didn't stream token deltas). The driver must still carry the reply on
    // turn.completed — otherwise the runtime delivers an empty reply / drops it.
    const d = await makeDriver({ script: "no-delta", reply: "你好，我是本地 Agent。" });
    const session = await d.openSession({ bindingId: "b1", scopeKey: "dm:p1" });
    const events = await collect(d.runTurn({ session, packet: parseWakePacket(dmWakePacket) }));
    expect(events.find((e) => e.type === "assistant.delta")).toBeUndefined(); // no deltas emitted
    const done = events.at(-1);
    expect(done?.type).toBe("turn.completed");
    expect((done as any).text).toBe("你好，我是本地 Agent。"); // reply captured from item/completed
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

  // P1-5: the App Server turn input must carry the FULL structured wake, not just
  // the message body.
  it("sends the structured wake as the turn input for a DM", async () => {
    const { driver, server } = await makeDriverWithServer();
    const session = await driver.openSession({ bindingId: "b1", scopeKey: "dm:p1" });
    await collect(driver.runTurn({ session, packet: parseWakePacket(dmWakePacket) }));
    const text = turnInputText(server);
    expect(text).toContain("hi 小龙");
    expect(text).toContain("dm.message.created");
    expect(text).toContain("dm:p1");
  });

  it("sends the channel scope + reply target in the turn input for a group @", async () => {
    const { driver, server } = await makeDriverWithServer();
    const session = await driver.openSession({ bindingId: "b1", scopeKey: "channel:ch9" });
    await collect(driver.runTurn({ session, packet: parseWakePacket(channelMentionWakePacket) }));
    const text = turnInputText(server);
    expect(text).toContain("channel.mention.created");
    expect(text).toContain("channel:ch9");
    expect(text).toContain("@小龙 一起爬山吗");
  });

  it("sends heartbeat + notifications as context (never the literal (heartbeat))", async () => {
    const { driver, server } = await makeDriverWithServer();
    const session = await driver.openSession({ bindingId: "b1", scopeKey: "owner:o1" });
    await collect(driver.runTurn({ session, packet: parseWakePacket(heartbeatWithNotificationsPacket) }));
    const text = turnInputText(server);
    expect(text).not.toBe("(heartbeat)");
    expect(text.toLowerCase()).toContain("heartbeat");
    expect(text).toContain("找搭子");
    expect(text.toLowerCase()).toMatch(/context|not (a )?command/);
  });
});
