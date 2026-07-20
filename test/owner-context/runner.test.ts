import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareOwnerContextRefresh } from "../../src/owner-context/runner.js";

describe("owner context refresh runner", () => {
  it("returns bounded local material then marks an identical refresh as no-change", async () => {
    const statePath = join(await mkdtemp(join(tmpdir(), "mingle-context-state-")), "state.json");
    const source = async () => [{ provider: "claude-code" as const, sessionId: "s1", project: "alpha", updatedAt: "2026-07-20T00:00:00Z", messages: [{ role: "user" as const, text: "decide product boundary" }] }];
    const first = await prepareOwnerContextRefresh({ runtime: "claude-code", days: 7, statePath, source });
    expect(first.materialChange).toBe(true);
    expect(first.prompt).toContain("owner-context-v1");
    expect(first.prompt).toContain("decide product boundary");
    const again = await prepareOwnerContextRefresh({ runtime: "claude-code", days: 7, statePath, source });
    expect(again.materialChange).toBe(false);
    expect(again.prompt).not.toContain("decide product boundary");
  });

  it("returns an honest no-session report", async () => {
    const statePath = join(await mkdtemp(join(tmpdir(), "mingle-context-empty-")), "state.json");
    const result = await prepareOwnerContextRefresh({ runtime: "codex", days: 7, statePath, source: async () => [] });
    expect(result.materialChange).toBe(false);
    expect(result.prompt).toContain("session_count");
    expect(result.prompt).toContain("0");
  });
});
