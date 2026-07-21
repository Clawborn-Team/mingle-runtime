import { describe, it, expect } from "vitest";
import { summarizeEvent } from "../src/runtime/activity-summary.js";
import type { RuntimeEvent } from "../src/runtime/driver.js";

const t = "turn-1";

describe("summarizeEvent — rolling one-line status of the latest intermediate product", () => {
  it("turn.started → a thinking line", () => {
    expect(summarizeEvent({ type: "turn.started", turnId: t })).toBe("正在思考…");
  });

  it("tool.started maps known tools (both codex item types and claude tool names) to friendly verbs", () => {
    expect(summarizeEvent({ type: "tool.started", turnId: t, toolId: "1", name: "commandExecution" })).toBe("正在执行命令…");
    expect(summarizeEvent({ type: "tool.started", turnId: t, toolId: "1", name: "Bash" })).toBe("正在执行命令…");
    expect(summarizeEvent({ type: "tool.started", turnId: t, toolId: "1", name: "Read" })).toBe("正在读取文件…");
    expect(summarizeEvent({ type: "tool.started", turnId: t, toolId: "1", name: "Edit" })).toBe("正在编辑文件…");
    expect(summarizeEvent({ type: "tool.started", turnId: t, toolId: "1", name: "mcpToolCall" })).toBe("正在调用工具…");
    // unknown tool falls back to its own name
    expect(summarizeEvent({ type: "tool.started", turnId: t, toolId: "1", name: "WebSearch" })).toBe("正在使用 WebSearch…");
  });

  it("tool.completed → a done line for the tool", () => {
    expect(summarizeEvent({ type: "tool.completed", turnId: t, toolId: "1", ok: true, detail: "Read" })).toBe("读取文件 完成");
    expect(summarizeEvent({ type: "tool.completed", turnId: t, toolId: "1", ok: false })).toBe("上一步 出错");
  });

  it("assistant.delta shows a truncated tail of the reply-so-far when provided", () => {
    const line = summarizeEvent({ type: "assistant.delta", turnId: t, text: "x" }, { assistantText: "我觉得方案 A 更好" });
    expect(line).toBe("正在回复：我觉得方案 A 更好");
    // no accumulated text → a generic writing line
    expect(summarizeEvent({ type: "assistant.delta", turnId: t, text: "x" })).toBe("正在整理回复…");
  });

  it("truncates a very long assistant tail to <=200 chars", () => {
    const long = "字".repeat(400);
    const line = summarizeEvent({ type: "assistant.delta", turnId: t, text: "x" }, { assistantText: long })!;
    expect(line.length).toBeLessThanOrEqual(200);
  });

  it("terminal events return null so the caller clears the indicator", () => {
    expect(summarizeEvent({ type: "turn.completed", turnId: t })).toBeNull();
    expect(summarizeEvent({ type: "turn.failed", turnId: t, error: "boom" })).toBeNull();
  });

  it("unmodeled events return null (keep the previous line)", () => {
    expect(summarizeEvent({ type: "file.changed", turnId: t, path: "/x" } as RuntimeEvent)).toBeNull();
  });
});
