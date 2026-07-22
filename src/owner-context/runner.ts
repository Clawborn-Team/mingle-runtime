import { fingerprintSessions } from "./fingerprint.js";
import { sanitizeSessions } from "./redact.js";
import { readRefreshState, writeRefreshState } from "./state.js";
import type { SessionSource } from "./types.js";

/**
 * Prepare an owner-context refresh turn WITHOUT consuming the window.
 *
 * The window is "consumed" (its fingerprint persisted as the last-successful state)
 * ONLY via the returned `commit()` — which the caller must invoke after the model
 * has actually distilled the report AND it was delivered to the Companion. This is
 * the fix for the premature no-change gate: a computed-but-undelivered refresh must
 * not silently mark the window as seen and turn the NEXT (real) refresh into a canned
 * empty report. See docs/architecture.md → Owner-context refresh.
 *
 * A failure while gathering source material IS recorded eagerly (status:"failure"):
 * it does not commit a fingerprint, so it never falsely satisfies the no-change gate.
 */
export async function prepareOwnerContextRefresh(opts: {
  runtime: string;
  mode?: "recent-briefing" | "owner-portrait";
  days: number;
  statePath: string;
  source: () => Promise<SessionSource[]>;
}): Promise<{ materialChange: boolean; fingerprint: string; prompt: string; commit: () => Promise<void> }> {
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
    // Commit is deferred to post-delivery: only a report that actually reached the
    // Companion is allowed to advance the window's last-successful fingerprint.
    const commit = async () => {
      await writeRefreshState(opts.statePath, { fingerprint, updatedAt: new Date().toISOString(), status: "success" });
    };
    return { materialChange, fingerprint, prompt, commit };
  } catch (error) {
    await writeRefreshState(opts.statePath, { updatedAt: new Date().toISOString(), status: "failure", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
