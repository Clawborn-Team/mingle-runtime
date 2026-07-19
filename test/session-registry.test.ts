import { describe, it, expect } from "vitest";
import { InMemorySessionRegistry } from "../src/runtime/session-registry.js";

describe("InMemorySessionRegistry (spec §5.3)", () => {
  it("records a mapping and reads it back by (binding, scope)", async () => {
    const reg = new InMemorySessionRegistry();
    await reg.put({
      bindingId: "b1",
      agentAccountId: "a1",
      runtimeKind: "codex",
      scopeKey: "dm:p1",
      providerSessionId: "thread-1",
    });
    const row = await reg.get("b1", "dm:p1");
    expect(row?.providerSessionId).toBe("thread-1");
    expect(row?.runtimeKind).toBe("codex");
  });

  it("returns undefined for an unknown (binding, scope)", async () => {
    const reg = new InMemorySessionRegistry();
    expect(await reg.get("b1", "dm:nope")).toBeUndefined();
  });

  it("isolates two scopes of the same binding", async () => {
    const reg = new InMemorySessionRegistry();
    await reg.put({ bindingId: "b1", agentAccountId: "a1", runtimeKind: "codex", scopeKey: "dm:p1", providerSessionId: "t-p1" });
    await reg.put({ bindingId: "b1", agentAccountId: "a1", runtimeKind: "codex", scopeKey: "dm:p2", providerSessionId: "t-p2" });
    expect((await reg.get("b1", "dm:p1"))?.providerSessionId).toBe("t-p1");
    expect((await reg.get("b1", "dm:p2"))?.providerSessionId).toBe("t-p2");
  });

  it("isolates the same scope across two bindings (no cross-binding reuse)", async () => {
    const reg = new InMemorySessionRegistry();
    await reg.put({ bindingId: "b1", agentAccountId: "a1", runtimeKind: "codex", scopeKey: "dm:p1", providerSessionId: "t-b1" });
    await reg.put({ bindingId: "b2", agentAccountId: "a2", runtimeKind: "claude-code", scopeKey: "dm:p1", providerSessionId: "t-b2" });
    expect((await reg.get("b1", "dm:p1"))?.providerSessionId).toBe("t-b1");
    expect((await reg.get("b2", "dm:p1"))?.providerSessionId).toBe("t-b2");
  });

  it("updates status fields (last_turn_at, health) on touch", async () => {
    const reg = new InMemorySessionRegistry();
    await reg.put({ bindingId: "b1", agentAccountId: "a1", runtimeKind: "codex", scopeKey: "dm:p1", providerSessionId: "t1" });
    await reg.touch("b1", "dm:p1", { lastTurnAt: 123, health: "ok" });
    const row = await reg.get("b1", "dm:p1");
    expect(row?.lastTurnAt).toBe(123);
    expect(row?.health).toBe("ok");
  });
});
