import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverClaudeSessions } from "../../src/owner-context/claude-sessions.js";

describe("Claude session discovery", () => {
  it("reads recent top-level project sessions, excludes internals/configured projects, and sorts deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "mingle-claude-"));
    const now = new Date("2026-07-21T00:00:00Z");
    await mkdir(join(root, "alpha", "subagents"), { recursive: true });
    await mkdir(join(root, "private"), { recursive: true });
    const line = (at: string, text: string) => JSON.stringify({ type: "user", timestamp: at, message: { role: "user", content: text } });
    await writeFile(join(root, "alpha", "new.jsonl"), line("2026-07-20T12:00:00Z", "new work") + "\n");
    await writeFile(join(root, "alpha", "old.jsonl"), line("2026-07-01T12:00:00Z", "old work") + "\n");
    await writeFile(join(root, "alpha", "x.meta.json"), "{}");
    await writeFile(join(root, "alpha", "subagents", "child.jsonl"), line("2026-07-20T13:00:00Z", "secret child"));
    await writeFile(join(root, "private", "hidden.jsonl"), line("2026-07-20T14:00:00Z", "hidden"));

    const sessions = await discoverClaudeSessions({ projectsRoot: root, now, days: 7, excludeProjects: ["private"] });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ provider: "claude-code", project: "alpha", sessionId: "new" });
    expect(sessions[0]!.messages[0]!.text).toBe("new work");
  });
});
