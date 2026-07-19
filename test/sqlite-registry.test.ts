import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteSessionRegistry } from "../src/runtime/sqlite-session-registry.js";

const dirs: string[] = [];
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "mingle-reg-"));
  dirs.push(dir);
  return join(dir, "registry.db");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("SqliteSessionRegistry (spec §5.3 persistence)", () => {
  it("puts and reads back a mapping", async () => {
    const reg = new SqliteSessionRegistry(tmpDbPath());
    await reg.put({ bindingId: "b1", agentAccountId: "a1", runtimeKind: "codex", scopeKey: "dm:p1", providerSessionId: "thr_1" });
    expect((await reg.get("b1", "dm:p1"))?.providerSessionId).toBe("thr_1");
    reg.close();
  });

  it("isolates two scopes and two bindings", async () => {
    const reg = new SqliteSessionRegistry(tmpDbPath());
    await reg.put({ bindingId: "b1", agentAccountId: "a1", runtimeKind: "codex", scopeKey: "dm:p1", providerSessionId: "t-a" });
    await reg.put({ bindingId: "b1", agentAccountId: "a1", runtimeKind: "codex", scopeKey: "dm:p2", providerSessionId: "t-b" });
    await reg.put({ bindingId: "b2", agentAccountId: "a2", runtimeKind: "claude-code", scopeKey: "dm:p1", providerSessionId: "t-c" });
    expect((await reg.get("b1", "dm:p1"))?.providerSessionId).toBe("t-a");
    expect((await reg.get("b1", "dm:p2"))?.providerSessionId).toBe("t-b");
    expect((await reg.get("b2", "dm:p1"))?.providerSessionId).toBe("t-c");
    reg.close();
  });

  it("upserts on the same (binding, scope)", async () => {
    const reg = new SqliteSessionRegistry(tmpDbPath());
    await reg.put({ bindingId: "b1", agentAccountId: "a1", runtimeKind: "codex", scopeKey: "dm:p1", providerSessionId: "thr_old" });
    await reg.put({ bindingId: "b1", agentAccountId: "a1", runtimeKind: "codex", scopeKey: "dm:p1", providerSessionId: "thr_new" });
    expect((await reg.get("b1", "dm:p1"))?.providerSessionId).toBe("thr_new");
    reg.close();
  });

  it("touches status fields", async () => {
    const reg = new SqliteSessionRegistry(tmpDbPath());
    await reg.put({ bindingId: "b1", agentAccountId: "a1", runtimeKind: "codex", scopeKey: "dm:p1", providerSessionId: "t1" });
    await reg.touch("b1", "dm:p1", { lastTurnAt: 999, health: "ok" });
    const row = await reg.get("b1", "dm:p1");
    expect(row?.lastTurnAt).toBe(999);
    expect(row?.health).toBe("ok");
    reg.close();
  });

  it("RECOVERS the thread across a process restart (reopen same file)", async () => {
    const path = tmpDbPath();
    const first = new SqliteSessionRegistry(path);
    await first.put({ bindingId: "b1", agentAccountId: "a1", runtimeKind: "codex", scopeKey: "dm:p1", providerSessionId: "thr_persisted" });
    first.close(); // simulate process exit

    const reopened = new SqliteSessionRegistry(path);
    const row = await reopened.get("b1", "dm:p1");
    expect(row?.providerSessionId).toBe("thr_persisted");
    expect(row?.runtimeKind).toBe("codex");
    reopened.close();
  });
});
