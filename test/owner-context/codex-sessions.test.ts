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

  it("reads the real App Server epoch timestamps and turn item envelope", async () => {
    const client = {
      async threadList() {
        return [{ id: "t-real", cwd: "/Users/me/code/mingle", updatedAt: 1_784_563_200 }];
      },
      async threadRead() {
        return {
          id: "t-real",
          turns: [{
            startedAt: 1_784_562_900,
            items: [
              { type: "userMessage", content: [{ type: "text", text: "把入口放到主页面" }] },
              { type: "agentMessage", text: "已经完成并验证" },
              { type: "webSearch", query: "ignored" },
            ],
          }],
        };
      },
    };

    const sessions = await discoverCodexSessions({
      client,
      now: new Date("2026-07-21T04:00:00Z"),
      days: 7,
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.updatedAt).toBe("2026-07-20T16:00:00.000Z");
    expect(sessions[0]!.messages).toEqual([
      { role: "user", text: "把入口放到主页面", timestamp: "2026-07-20T15:55:00.000Z" },
      { role: "assistant", text: "已经完成并验证", timestamp: "2026-07-20T15:55:00.000Z" },
    ]);
  });
});
