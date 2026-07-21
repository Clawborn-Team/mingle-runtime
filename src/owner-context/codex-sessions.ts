import { basename } from "node:path";
import type { SessionSource } from "./types.js";

export type CodexThreadSummary = { id: string; cwd?: string; updatedAt?: string | number; updated_at?: string | number };
export interface CodexHistoryClient {
  threadList(params: { limit?: number }): Promise<CodexThreadSummary[]>;
  threadRead(id: string, includeTurns: boolean): Promise<{ id: string; turns?: Array<Record<string, unknown>> }>;
}

function timestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  const text = String(value ?? "").trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const numeric = Number(text);
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }
  return Date.parse(text);
}

function turnMessages(turn: Record<string, any>, fallbackMs: number) {
  const turnMs = timestampMs(turn.startedAt ?? turn.createdAt ?? turn.created_at);
  const timestamp = new Date(Number.isFinite(turnMs) ? turnMs : fallbackMs).toISOString();
  const messages: Array<{ role: "user" | "assistant"; text: string; timestamp: string }> = [];

  if (typeof turn.input === "string" && turn.input.trim()) {
    messages.push({ role: "user", text: turn.input, timestamp });
  }
  if (typeof turn.output === "string" && turn.output.trim()) {
    messages.push({ role: "assistant", text: turn.output, timestamp });
  }
  for (const item of Array.isArray(turn.items) ? turn.items : []) {
    if (item?.type === "userMessage") {
      const text = (Array.isArray(item.content) ? item.content : [])
        .filter((part: any) => part?.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n")
        .trim();
      if (text) messages.push({ role: "user", text, timestamp });
    } else if (item?.type === "agentMessage" && typeof item.text === "string" && item.text.trim()) {
      messages.push({ role: "assistant", text: item.text, timestamp });
    }
  }
  return messages;
}

export async function discoverCodexSessions(opts: { client: CodexHistoryClient; now?: Date; days?: number; excludeProjects?: string[]; excludeSessions?: string[] }): Promise<SessionSource[]> {
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - (opts.days ?? 7) * 86_400_000;
  const excludedProjects = new Set(opts.excludeProjects ?? []);
  const excludedSessions = new Set(opts.excludeSessions ?? []);
  const threads = await opts.client.threadList({ limit: 200 });
  const result: SessionSource[] = [];
  for (const thread of threads) {
    const updated = timestampMs(thread.updatedAt ?? thread.updated_at);
    const project = basename(thread.cwd ?? "unknown") || "unknown";
    if (!Number.isFinite(updated) || updated < cutoff || updated > now.getTime() + 86_400_000) continue;
    if (excludedProjects.has(project) || excludedSessions.has(thread.id)) continue;
    const detail = await opts.client.threadRead(thread.id, true);
    const messages = (detail.turns ?? []).flatMap((turn) => turnMessages(turn, updated));
    result.push({ provider: "codex", sessionId: thread.id, project, updatedAt: new Date(updated).toISOString(), messages });
  }
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sessionId.localeCompare(b.sessionId));
}
