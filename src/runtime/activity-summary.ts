/**
 * Rolling one-line status summary of a turn's latest intermediate product
 * (spec 2026-07-21 live-status §4.3). The consumer feeds each streamed RuntimeEvent
 * here and, when a non-null line comes back, pushes it as the agent's ephemeral
 * activity `detail` (latest-wins, never persisted). Terminal events return null so
 * the caller clears the indicator instead of showing a stale line.
 *
 * Pure + provider-neutral: it maps both Codex item types (`commandExecution`,
 * `mcpToolCall`) and Claude tool names (`Bash`, `Read`, `Edit`, …) to friendly verbs.
 */
import type { RuntimeEvent } from "./driver.js";

/** Cap must match the server's ACTIVITY_DETAIL_MAX (spec §4.2). */
export const SUMMARY_MAX = 200;

export type SummaryContext = {
  /** The assistant reply accumulated so far this turn, for a live "writing" tail. */
  assistantText?: string;
};

/** Friendly verb for a tool, keyed by Codex item type OR Claude tool name. */
function friendlyTool(name: string): string {
  const n = name.toLowerCase();
  if (n === "commandexecution" || n === "bash" || n === "shell") return "执行命令";
  if (n === "read" || n === "read_file" || n === "readfile") return "读取文件";
  if (n === "write" || n === "edit" || n === "multiedit" || n === "notebookedit") return "编辑文件";
  if (n === "mcptoolcall" || n.startsWith("mcp__") || n.startsWith("mcp:")) return "调用工具";
  return "";
}

function truncate(s: string): string {
  return s.length <= SUMMARY_MAX ? s : s.slice(0, SUMMARY_MAX - 1) + "…";
}

/** Tail of the reply-so-far, kept short for a rolling line. */
function replyTail(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  const tail = trimmed.length > 120 ? "…" + trimmed.slice(-120) : trimmed;
  return truncate(`正在回复：${tail}`);
}

export function summarizeEvent(ev: RuntimeEvent, ctx: SummaryContext = {}): string | null {
  switch (ev.type) {
    case "turn.started":
      return "正在思考…";
    case "tool.started": {
      const verb = friendlyTool(ev.name);
      return verb ? `正在${verb}…` : `正在使用 ${ev.name}…`;
    }
    case "tool.completed": {
      if (!ev.ok) return "上一步 出错";
      const verb = ev.detail ? friendlyTool(ev.detail) : "";
      return `${verb || "上一步"} 完成`;
    }
    case "assistant.delta":
      return ctx.assistantText && ctx.assistantText.trim() ? replyTail(ctx.assistantText) : "正在整理回复…";
    case "turn.completed":
    case "turn.failed":
      return null;
    default:
      return null;
  }
}
