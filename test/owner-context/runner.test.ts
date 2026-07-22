import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareOwnerContextRefresh } from "../../src/owner-context/runner.js";
import { readRefreshState } from "../../src/owner-context/state.js";

describe("owner context refresh runner", () => {
  it("returns bounded local material and only marks no-change once a DELIVERED refresh committed the window", async () => {
    const statePath = join(await mkdtemp(join(tmpdir(), "mingle-context-state-")), "state.json");
    const source = async () => [{ provider: "claude-code" as const, sessionId: "s1", project: "alpha", updatedAt: "2026-07-20T00:00:00Z", messages: [{ role: "user" as const, text: "decide product boundary" }] }];
    const first = await prepareOwnerContextRefresh({ runtime: "claude-code", days: 7, statePath, source });
    expect(first.materialChange).toBe(true);
    expect(first.prompt).toContain("owner-context-v1");
    expect(first.prompt).toContain("decide product boundary");
    // The delivery of the first report commits the window fingerprint.
    await first.commit();
    const again = await prepareOwnerContextRefresh({ runtime: "claude-code", days: 7, statePath, source });
    expect(again.materialChange).toBe(false);
    expect(again.prompt).not.toContain("decide product boundary");
  });

  it("does NOT commit the fingerprint at prepare-time — an undelivered refresh cannot consume the window", async () => {
    const statePath = join(await mkdtemp(join(tmpdir(), "mingle-context-nocommit-")), "state.json");
    const source = async () => [{ provider: "codex" as const, sessionId: "s1", project: "alpha", updatedAt: "2026-07-20T00:00:00Z", messages: [{ role: "user" as const, text: "decide product boundary" }] }];
    // Prepare but NEVER call commit() (models never distilled / never delivered).
    const first = await prepareOwnerContextRefresh({ runtime: "codex", days: 7, statePath, source });
    expect(first.materialChange).toBe(true);
    // No success fingerprint was persisted.
    expect((await readRefreshState(statePath)).fingerprint).toBeUndefined();
    // A subsequent refresh over the identical window still yields the rich report,
    // because the window was never actually consumed by a delivered report.
    const second = await prepareOwnerContextRefresh({ runtime: "codex", days: 7, statePath, source });
    expect(second.materialChange).toBe(true);
    expect(second.prompt).toContain("decide product boundary");
  });

  it("returns an honest no-session report", async () => {
    const statePath = join(await mkdtemp(join(tmpdir(), "mingle-context-empty-")), "state.json");
    const result = await prepareOwnerContextRefresh({ runtime: "codex", days: 7, statePath, source: async () => [] });
    expect(result.materialChange).toBe(false);
    expect(result.prompt).toContain("session_count");
    expect(result.prompt).toContain("0");
  });

  it("builds an owner portrait task instead of a recent briefing when requested", async () => {
    const statePath = join(await mkdtemp(join(tmpdir(), "mingle-context-portrait-")), "state.json");
    const result = await prepareOwnerContextRefresh({
      runtime: "codex", mode: "owner-portrait", days: 14, statePath,
      source: async () => [{ provider: "codex", sessionId: "s", project: "alpha", updatedAt: "2026-07-20T00:00:00Z", messages: [{ role: "user", text: "先确认产品边界" }] }],
    });
    expect(result.prompt).toContain("owner-portrait");
    expect(result.prompt).toContain("portrait_signals");
  });
});
