/**
 * Validate a distilled owner-context report against the `owner-context-v1` shape
 * FOR A GIVEN MODE (recent-briefing vs owner-portrait).
 *
 * This is the guard for the no-change-window commit (Codex P1-4): a provider
 * apology, a truncated/invalid JSON, or a report produced for the WRONG mode must
 * NOT be allowed to consume the refresh window. Only a report that both parses and
 * satisfies the requested mode's shape counts as a real distilled report; anything
 * else leaves the window open so the next externally-triggered refresh re-distills.
 *
 * We validate the STRUCTURAL contract (schema_version + mode + the mode's required
 * fields with the right kinds), not the semantic content — the model owns content.
 */
import type { OwnerContextTask } from "../runtime/wake-render.js";

type Mode = OwnerContextTask["mode"];

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validRecentBriefing(report: Record<string, unknown>): boolean {
  if (report.mode !== "recent-briefing") return false;
  const window = report.window;
  if (
    !isRecord(window) ||
    typeof window.days !== "number" ||
    typeof window.from !== "string" ||
    typeof window.to !== "string"
  ) {
    return false;
  }
  const recent = report.recent_activity;
  if (!Array.isArray(recent)) return false;
  for (const item of recent) {
    if (
      !isRecord(item) ||
      typeof item.topic !== "string" ||
      typeof item.summary !== "string" ||
      typeof item.status !== "string" ||
      typeof item.last_seen_at !== "string" ||
      typeof item.confidence !== "string"
    ) {
      return false;
    }
  }
  if (!isStringArray(report.decisions)) return false;
  if (!isStringArray(report.open_threads)) return false;
  if (!isStringArray(report.current_concerns)) return false;
  if (!isStringArray(report.questions_companion_may_ask)) return false;
  if (typeof report.material_change !== "boolean") return false;
  return true;
}

function validOwnerPortrait(report: Record<string, unknown>): boolean {
  if (report.mode !== "owner-portrait") return false;
  const signals = report.portrait_signals;
  if (!Array.isArray(signals)) return false;
  for (const item of signals) {
    if (
      !isRecord(item) ||
      typeof item.dimension !== "string" ||
      typeof item.observation !== "string" ||
      typeof item.confidence !== "string" ||
      typeof item.evidence_count !== "number" ||
      typeof item.observed_across_projects !== "number"
    ) {
      return false;
    }
  }
  if (!isStringArray(report.contradictions)) return false;
  if (!isStringArray(report.insufficient_evidence)) return false;
  return true;
}

/**
 * Whether `text` is a valid owner-context-v1 report for the requested `mode`.
 * A report whose `mode` field disagrees with the requested mode is INVALID
 * (wrong-mode reply must not consume the window).
 */
export function isValidOwnerContextReport(text: string | undefined, mode: Mode): boolean {
  if (!text || !text.trim()) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  if (parsed.schema_version !== "owner-context-v1") return false;
  return mode === "owner-portrait" ? validOwnerPortrait(parsed) : validRecentBriefing(parsed);
}
