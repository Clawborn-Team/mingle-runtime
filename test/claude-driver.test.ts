import { describe, it, expect } from "vitest";
import { ClaudeAgentDriver } from "../src/claude/driver.js";
import { fakeClaudeQuery, type FakeScript } from "../src/claude/fake-query.js";
import type { QueryOptions } from "../src/claude/sdk-types.js";
import type { RuntimeEvent } from "../src/runtime/driver.js";
import { parseWakePacket } from "../src/protocol/wake-packet.js";
import { dmWakePacket } from "./fixtures/wake-packets.js";

async function collect(stream: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const out: RuntimeEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

/** A stand-in for the in-process Mingle SDK-MCP server the install flow builds
 *  (createSdkMcpServer output) — the driver passes it through to query(). */
const mingleMcp = { "mingle-tools": { type: "sdk", instance: { restricted: true } } };

/** Build a driver whose query records the options it was called with. */
function makeDriver(script: FakeScript = "reply", opts: { reply?: string; sessionId?: string } = {}) {
  const calls: { prompt: string; options?: QueryOptions }[] = [];
  const query = fakeClaudeQuery(script, { ...opts, onCall: (c) => calls.push(c) });
  const driver = new ClaudeAgentDriver({
    query,
    cwd: "/tmp/ws",
    allowedTools: ["Read"],
    mcpServers: mingleMcp,
  });
  return { driver, calls };
}

describe("ClaudeAgentDriver", () => {
  it("declares claude-code kind + capabilities", () => {
    const { driver } = makeDriver();
    expect(driver.kind).toBe("claude-code");
    expect(driver.capabilities.resume).toBe(true);
    expect(driver.capabilities.approvals).toBe(true);
  });

  it("maps the SDK message stream to RuntimeEvents", async () => {
    const { driver } = makeDriver("reply", { reply: "嗨！", sessionId: "sess-1" });
    const session = await driver.openSession({ bindingId: "b1", scopeKey: "dm:p1" });
    expect(session.ref.providerSessionId).toBe("sess-1");

    const events = await collect(driver.runTurn({ session, packet: parseWakePacket(dmWakePacket) }));
    expect(events[0]?.type).toBe("turn.started");
    expect(events.find((e) => e.type === "assistant.delta")).toBeTruthy();
    const done = events.at(-1);
    expect(done?.type).toBe("turn.completed");
    expect((done as any).text).toContain("嗨！");
  });

  it("maps an error result to turn.failed", async () => {
    const { driver } = makeDriver("error");
    const session = await driver.openSession({ bindingId: "b1", scopeKey: "dm:p1" });
    const events = await collect(driver.runTurn({ session, packet: parseWakePacket(dmWakePacket) }));
    expect(events.at(-1)?.type).toBe("turn.failed");
  });

  it("resumes by explicit session_id and NEVER uses continue:true (§5.5)", async () => {
    const { driver, calls } = makeDriver("reply", { sessionId: "sess-abc" });
    const session = await driver.openSession({ bindingId: "b1", scopeKey: "dm:p1" });
    await collect(driver.runTurn({ session, packet: parseWakePacket(dmWakePacket) }));

    const resumed = await driver.resumeSession(session.ref);
    await collect(driver.runTurn({ session: resumed, packet: parseWakePacket(dmWakePacket) }));

    // every turn passed resume with the captured id, and NONE passed continue
    const turnCalls = calls.filter((c) => c.prompt !== "");
    expect(turnCalls.every((c) => c.options?.continue !== true)).toBe(true);
    expect(turnCalls.some((c) => c.options?.resume === "sess-abc")).toBe(true);
  });

  it("registers the in-process Mingle MCP tool + a canUseTool permission gate", async () => {
    const { driver, calls } = makeDriver();
    const session = await driver.openSession({ bindingId: "b1", scopeKey: "dm:p1" });
    await collect(driver.runTurn({ session, packet: parseWakePacket(dmWakePacket) }));
    const turnCall = calls.find((c) => c.prompt !== "");
    expect(turnCall?.options?.mcpServers).toBeTruthy();
    expect(typeof turnCall?.options?.canUseTool).toBe("function");
  });

  it("denies a disallowed tool through canUseTool (hook deny)", async () => {
    const { driver, calls } = makeDriver();
    const session = await driver.openSession({ bindingId: "b1", scopeKey: "dm:p1" });
    await collect(driver.runTurn({ session, packet: parseWakePacket(dmWakePacket) }));
    const canUseTool = calls.find((c) => c.prompt !== "")?.options?.canUseTool!;
    const decision = await canUseTool("Bash", { command: "rm -rf /" });
    expect(decision.behavior).toBe("deny");
    const allowed = await canUseTool("Read", { path: "x" });
    expect(allowed.behavior).toBe("allow");
  });

  it("gives two scopes two distinct sessions (isolation)", async () => {
    const query = fakeClaudeQuery("reply", { sessionIdPerScope: true });
    const driver = new ClaudeAgentDriver({ query, cwd: "/tmp/ws" });
    const a = await driver.openSession({ bindingId: "b1", scopeKey: "dm:p1" });
    await collect(driver.runTurn({ session: a, packet: parseWakePacket(dmWakePacket) }));
    const b = await driver.openSession({ bindingId: "b1", scopeKey: "channel:c9" });
    await collect(driver.runTurn({ session: b, packet: parseWakePacket(dmWakePacket) }));
    expect(a.ref.providerSessionId).not.toBe(b.ref.providerSessionId);
  });
});
