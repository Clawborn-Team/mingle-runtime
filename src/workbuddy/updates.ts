/**
 * Pure ACP `session/update` → unified RuntimeEvent mapper (spec §5). Kept separate
 * from the client/driver so the deterministic translation is unit-tested with literal
 * ACP payloads (no faked provider — the provider is exercised by the real smoke tests).
 * Only the variants v1 surfaces are mapped; unmodelled ones (plan, mode, …) are ignored.
 */
import type { RuntimeEvent } from "../runtime/driver.js";

export type AcpUpdate = { sessionUpdate: string; [k: string]: unknown };

/** Text a chunk contributes to the accumulated final reply (`""` for non-text updates). */
export function textOf(update: AcpUpdate): string {
  if (update.sessionUpdate === "agent_message_chunk") {
    const content = update.content as { type?: string; text?: unknown } | undefined;
    if (content?.type === "text" && typeof content.text === "string") return content.text;
  }
  return "";
}

export function mapSessionUpdate(update: AcpUpdate, turnId: string): RuntimeEvent[] {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = textOf(update);
      return text ? [{ type: "assistant.delta", turnId, text }] : [];
    }
    case "tool_call": {
      const toolId = String(update.toolCallId ?? "");
      const name = String(update.title ?? update.kind ?? "tool");
      return [{ type: "tool.started", turnId, toolId, name }];
    }
    case "tool_call_update": {
      const status = update.status;
      if (status === "completed" || status === "failed") {
        return [{ type: "tool.completed", turnId, toolId: String(update.toolCallId ?? ""), ok: status === "completed" }];
      }
      return [];
    }
    default:
      return [];
  }
}
