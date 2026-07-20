import { fingerprintSessions } from "./fingerprint.js";
import { sanitizeSessions } from "./redact.js";
import { readRefreshState, writeRefreshState } from "./state.js";
import type { SessionSource } from "./types.js";

export async function prepareOwnerContextRefresh(opts: {
  runtime: string;
  mode?: "recent-briefing" | "owner-portrait";
  days: number;
  statePath: string;
  source: () => Promise<SessionSource[]>;
}): Promise<{ materialChange: boolean; fingerprint: string; prompt: string }> {
  try {
    const sessions = sanitizeSessions(await opts.source());
    const fingerprint = fingerprintSessions(sessions);
    const previous = await readRefreshState(opts.statePath);
    const mode = opts.mode ?? "recent-briefing";
    const materialChange = sessions.length > 0 && (mode === "owner-portrait" || previous.fingerprint !== fingerprint);
    const now = new Date();
    const from = new Date(now.getTime() - opts.days * 86_400_000);
    const summary = { runtime: opts.runtime, session_count: sessions.length, project_count: new Set(sessions.map((session) => session.project)).size };
    const prompt = materialChange
      ? mode === "owner-portrait"
        ? `Use the mingle-owner-context Skill. Produce only a valid owner-context-v1 owner-portrait JSON with portrait_signals, contradictions, and insufficient_evidence.\nWindow: ${JSON.stringify({ days: opts.days, from: from.toISOString(), to: now.toISOString() })}\nSource summary: ${JSON.stringify(summary)}\nSanitized local session material:\n${JSON.stringify(sessions)}`
        : `Use the mingle-owner-context Skill. Produce only a valid owner-context-v1 recent-briefing JSON.\nWindow: ${JSON.stringify({ days: opts.days, from: from.toISOString(), to: now.toISOString() })}\nSource summary: ${JSON.stringify(summary)}\nSanitized local session material:\n${JSON.stringify(sessions)}`
      : `Use the mingle-owner-context Skill. Produce only this valid no-change owner-context-v1 report: ${JSON.stringify({ schema_version: "owner-context-v1", mode: "recent-briefing", window: { days: opts.days, from: from.toISOString(), to: now.toISOString() }, source_summary: summary, recent_activity: [], decisions: [], open_threads: [], current_concerns: [], questions_companion_may_ask: [], material_change: false })}`;
    await writeRefreshState(opts.statePath, { fingerprint, updatedAt: now.toISOString(), status: "success" });
    return { materialChange, fingerprint, prompt };
  } catch (error) {
    await writeRefreshState(opts.statePath, { updatedAt: new Date().toISOString(), status: "failure", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
