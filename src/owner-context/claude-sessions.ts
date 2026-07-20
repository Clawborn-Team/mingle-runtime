import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { SessionMessage, SessionSource } from "./types.js";

export async function discoverClaudeSessions(opts: {
  projectsRoot: string;
  now?: Date;
  days?: number;
  excludeProjects?: string[];
  excludeSessions?: string[];
}): Promise<SessionSource[]> {
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - (opts.days ?? 7) * 86_400_000;
  const excludedProjects = new Set(opts.excludeProjects ?? []);
  const excludedSessions = new Set(opts.excludeSessions ?? []);
  const projects = (await readdir(opts.projectsRoot, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory());
  const result: SessionSource[] = [];
  for (const projectEntry of projects.sort((a, b) => a.name.localeCompare(b.name))) {
    if (excludedProjects.has(projectEntry.name)) continue;
    const dir = join(opts.projectsRoot, projectEntry.name);
    const files = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl") && !entry.name.endsWith(".meta.json"));
    for (const file of files) {
      const sessionId = basename(file.name, ".jsonl");
      if (excludedSessions.has(sessionId)) continue;
      const path = join(dir, file.name);
      const fileStat = await stat(path);
      const raw = await readFile(path, "utf8");
      const messages = raw.split("\n").flatMap((line): SessionMessage[] => {
        if (!line.trim()) return [];
        try {
          const row = JSON.parse(line) as any;
          const role = String(row.message?.role ?? row.type ?? "");
          if (!(["user", "assistant", "system", "tool"] as string[]).includes(role)) return [];
          const value = row.message?.content ?? row.content ?? "";
          const text = typeof value === "string" ? value : Array.isArray(value) ? value.filter((part) => part?.type === "text").map((part) => part.text).join("\n") : "";
          return text ? [{ role: role as SessionMessage["role"], text, ...(row.timestamp ? { timestamp: String(row.timestamp) } : {}) }] : [];
        } catch { return []; }
      });
      const timestamps = messages.map((message) => Date.parse(message.timestamp ?? "")).filter(Number.isFinite);
      // Session timestamps are authoritative when present; mtime is only a
      // fallback for older/partial files (copying a stale archive must not make it recent).
      const updated = timestamps.length ? Math.max(...timestamps) : fileStat.mtimeMs;
      if (updated < cutoff || updated > now.getTime() + 86_400_000) continue;
      result.push({ provider: "claude-code", sessionId, project: projectEntry.name, updatedAt: new Date(updated).toISOString(), messages });
    }
  }
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sessionId.localeCompare(b.sessionId));
}
