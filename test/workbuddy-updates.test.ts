import { describe, it, expect } from "vitest";
import { mapSessionUpdate, textOf } from "../src/workbuddy/updates.js";

describe("mapSessionUpdate", () => {
  it("maps an agent_message_chunk to assistant.delta + contributes its text", () => {
    const u = { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } };
    expect(mapSessionUpdate(u, "t1")).toEqual([{ type: "assistant.delta", turnId: "t1", text: "hi" }]);
    expect(textOf(u)).toBe("hi");
  });

  it("maps a tool_call (pending) to tool.started", () => {
    const u = { sessionUpdate: "tool_call", toolCallId: "c1", title: "read_file", status: "pending" };
    expect(mapSessionUpdate(u, "t1")).toEqual([
      { type: "tool.started", turnId: "t1", toolId: "c1", name: "read_file" },
    ]);
    expect(textOf(u)).toBe("");
  });

  it("maps a completed tool_call_update to tool.completed", () => {
    const u = { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed" };
    expect(mapSessionUpdate(u, "t1")).toEqual([
      { type: "tool.completed", turnId: "t1", toolId: "c1", ok: true },
    ]);
  });

  it("maps a failed tool_call_update to tool.completed ok:false", () => {
    const u = { sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed" };
    expect(mapSessionUpdate(u, "t1")).toEqual([
      { type: "tool.completed", turnId: "t1", toolId: "c1", ok: false },
    ]);
  });

  it("ignores unmodelled updates (plan / mode) without throwing", () => {
    expect(mapSessionUpdate({ sessionUpdate: "plan", entries: [] }, "t1")).toEqual([]);
    expect(textOf({ sessionUpdate: "plan" })).toBe("");
  });
});
