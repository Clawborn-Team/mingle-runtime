import { basename } from "node:path";
import type { SessionSource } from "./types.js";

export type CodexThreadSummary = { id: string; cwd?: string; updatedAt?: string; updated_at?: string };
export interface CodexHistoryClient {
  threadList(params: { limit?: number }): Promise<CodexThreadSummary[]>;
  threadRead(id: string, includeTurns: boolean): Promise<{ id: string; turns?: Array<Record<string, unknown>> }>;
}

export async function discoverCodexSessions(opts: { client: CodexHistoryClient; now?: Date; days?: number; excludeProjects?: string[]; excludeSessions?: string[] }): Promise<SessionSource[]> {
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - (opts.days ?? 7) * 86_400_000;
  const excludedProjects = new Set(opts.excludeProjects ?? []);
  const excludedSessions = new Set(opts.excludeSessions ?? []);
  const threads = await opts.client.threadList({ limit: 200 });
  const result: SessionSource[] = [];
  for (const thread of threads) {
    const updatedAt = String(thread.updatedAt ?? thread.updated_at ?? "");
    const updated = Date.parse(updatedAt);
    const project = basename(thread.cwd ?? "unknown") || "unknown";
    if (!Number.isFinite(updated) || updated < cutoff || updated > now.getTime() + 86_400_000) continue;
    if (excludedProjects.has(project) || excludedSessions.has(thread.id)) continue;
    const detail = await opts.client.threadRead(thread.id, true);
    const messages = (detail.turns ?? []).flatMap((turn: any) => {
      const timestamp = String(turn.createdAt ?? turn.created_at ?? updatedAt);
      const out = [];
      if (typeof turn.input === "string") out.push({ role: "user" as const, text: turn.input, timestamp });
      if (typeof turn.output === "string") out.push({ role: "assistant" as const, text: turn.output, timestamp });
      return out;
    });
    result.push({ provider: "codex", sessionId: thread.id, project, updatedAt: new Date(updated).toISOString(), messages });
  }
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sessionId.localeCompare(b.sessionId));
}
