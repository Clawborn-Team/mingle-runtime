import { describe, expect, it } from "vitest";
import { discoverCodexSessions } from "../../src/owner-context/codex-sessions.js";

describe("Codex App Server session discovery", () => {
  it("uses thread/list then thread/read(includeTurns:true), filters seven days and exclusions", async () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      async threadList(params: unknown) { calls.push(["list", params]); return [
        { id: "t-new", cwd: "/Users/me/code/alpha", updatedAt: "2026-07-20T00:00:00Z" },
        { id: "t-old", cwd: "/Users/me/code/old", updatedAt: "2026-06-01T00:00:00Z" },
        { id: "t-private", cwd: "/Users/me/private", updatedAt: "2026-07-20T00:00:00Z" },
      ]; },
      async threadRead(id: string, includeTurns: boolean) { calls.push(["read", { id, includeTurns }]); return { id, turns: [{ createdAt: "2026-07-20T00:00:00Z", input: "design memory", output: "done" }] }; },
    };
    const sessions = await discoverCodexSessions({ client, now: new Date("2026-07-21T00:00:00Z"), days: 7, excludeProjects: ["private"] });
    expect(sessions.map((session) => session.sessionId)).toEqual(["t-new"]);
    expect(calls).toContainEqual(["read", { id: "t-new", includeTurns: true }]);
    expect(sessions[0]!.project).toBe("alpha");
  });
});
