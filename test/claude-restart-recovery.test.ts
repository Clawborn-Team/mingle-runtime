import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAgentDriver } from "../src/claude/driver.js";
import { fakeClaudeQuery } from "../src/claude/fake-query.js";
import type { QueryOptions } from "../src/claude/sdk-types.js";
import { SqliteSessionRegistry } from "../src/runtime/sqlite-session-registry.js";
import { processWake, type EventCenterClient, type Binding } from "../src/runtime/consumer.js";
import { parseWakePacket } from "../src/protocol/wake-packet.js";
import { dmWakePacket } from "./fixtures/wake-packets.js";

const dirs: string[] = [];
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "mingle-claude-restart-"));
  dirs.push(dir);
  return join(dir, "registry.db");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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
    async postToChannel() {
      return { ok: true, status: 201 };
    },
  };
}

/** A Claude driver whose fake query records the resume ids it was asked to use. */
function makeClaude(fixedId?: string) {
  const resumeIds: (string | undefined)[] = [];
  const query = fakeClaudeQuery("reply", {
    ...(fixedId ? { sessionId: fixedId } : {}),
    onCall: (c: { prompt: string; options?: QueryOptions }) => {
      if (c.prompt !== "") resumeIds.push(c.options?.resume);
    },
  });
  return { driver: new ClaudeAgentDriver({ query, cwd: "/tmp/ws" }), resumeIds };
}

const binding: Binding = { bindingId: "b1", agentAccountId: "a1", ownerAccountId: "o1", runtimeKind: "claude-code" };

describe("Claude restart recovery (spec §5.5 / §13.2)", () => {
  it("resumes the same Claude session_id after a process restart (no continue-guessing)", async () => {
    const dbPath = tmpDbPath();
    const packet = parseWakePacket(dmWakePacket);

    // --- process 1: first wake mints + persists a session_id ---
    const reg1 = new SqliteSessionRegistry(dbPath);
    const c1 = makeClaude("sess-persisted");
    await processWake({ packet, binding, driver: c1.driver, registry: reg1, imClient: noopIm() });
    const sessionId = (await reg1.get("b1", "dm:p1"))?.providerSessionId;
    expect(sessionId).toBe("sess-persisted");
    reg1.close();

    // --- process 2: fresh registry (same file) + fresh driver ---
    const reg2 = new SqliteSessionRegistry(dbPath);
    const c2 = makeClaude("sess-persisted");
    expect((await reg2.get("b1", "dm:p1"))?.providerSessionId).toBe("sess-persisted");

    await processWake({ packet, binding, driver: c2.driver, registry: reg2, imClient: noopIm() });
    // the recovered turn resumed the SAME id via `resume` (never continue:true)
    expect(c2.resumeIds).toContain("sess-persisted");
    reg2.close();
  });
});
