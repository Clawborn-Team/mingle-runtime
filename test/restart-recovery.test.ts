import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonRpcStdioConnection } from "../src/codex/jsonrpc-stdio.js";
import { FakeAppServer } from "../src/codex/fake-app-server.js";
import { CodexAppServerClient } from "../src/codex/client.js";
import { CodexAppServerDriver } from "../src/codex/driver.js";
import { SqliteSessionRegistry } from "../src/runtime/sqlite-session-registry.js";
import { processWake, type EventCenterClient, type Binding } from "../src/runtime/consumer.js";
import { parseWakePacket } from "../src/protocol/wake-packet.js";
import { dmWakePacket } from "./fixtures/wake-packets.js";

const dirs: string[] = [];
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "mingle-restart-"));
  dirs.push(dir);
  return join(dir, "registry.db");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fresh FakeAppServer-backed Codex driver that RECORDS whether resume was used. */
async function makeCodex() {
  let client!: JsonRpcStdioConnection;
  const resumed: string[] = [];
  const server = new FakeAppServer({ reply: "hi" });
  const serverConn = new JsonRpcStdioConnection({ write: (l) => client.receive(l) });
  client = new JsonRpcStdioConnection({ write: (l) => serverConn.receive(l) });
  server.attach(serverConn);
  const codex = new CodexAppServerClient(client);
  // Spy on threadResume to prove recovery resumes rather than starts fresh.
  const origResume = codex.threadResume.bind(codex);
  codex.threadResume = async (id: string) => {
    resumed.push(id);
    return origResume(id);
  };
  await codex.initialize({ name: "mingle-runtime", version: "0" });
  return { driver: new CodexAppServerDriver({ client: codex }), resumed };
}

function noopIm(): EventCenterClient {
  return {
    async getUpdates() {
      return { events: [] };
    },
    async ack() {},
    async nack() {},
    async sendDm() {
      return { ok: true, status: 201 };
    },
  };
}

const binding: Binding = { bindingId: "b1", agentAccountId: "a1", ownerAccountId: "o1", runtimeKind: "codex" };

describe("restart recovery (spec §5.4 / §13.2)", () => {
  it("resumes the same Codex thread after a process restart", async () => {
    const dbPath = tmpDbPath();
    const packet = parseWakePacket(dmWakePacket);

    // --- process 1: first wake opens a thread, persisted to SQLite ---
    const reg1 = new SqliteSessionRegistry(dbPath);
    const c1 = await makeCodex();
    await processWake({ packet, binding, driver: c1.driver, registry: reg1, imClient: noopIm() });
    const threadId = (await reg1.get("b1", "dm:p1"))?.providerSessionId;
    expect(threadId).toMatch(/^thr_/);
    reg1.close(); // simulate exit

    // --- process 2: fresh registry (same file) + fresh driver ---
    const reg2 = new SqliteSessionRegistry(dbPath);
    const c2 = await makeCodex();
    // recovered mapping is present before any new wake
    expect((await reg2.get("b1", "dm:p1"))?.providerSessionId).toBe(threadId);

    await processWake({ packet, binding, driver: c2.driver, registry: reg2, imClient: noopIm() });
    // the second process RESUMED the recovered thread — did not start a new one
    expect(c2.resumed).toContain(threadId);
    expect((await reg2.get("b1", "dm:p1"))?.providerSessionId).toBe(threadId);
    reg2.close();
  });
});
