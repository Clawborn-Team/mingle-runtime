export type SessionProvider = "claude-code" | "codex" | "openclaw";
export type SessionMessage = { role: "user" | "assistant" | "system" | "tool"; text: string; timestamp?: string };
export type SessionSource = {
  provider: SessionProvider;
  sessionId: string;
  project: string;
  updatedAt: string;
  messages: SessionMessage[];
};

export type OwnerContextBriefing = {
  schema_version: "owner-context-v1";
  mode: "recent-briefing";
  window: { days: number; from: string; to: string };
  source_summary: { runtime: string; session_count: number; project_count: number };
  recent_activity: Array<{ topic: string; summary: string; status: string; last_seen_at: string; confidence: string }>;
  decisions: string[];
  open_threads: string[];
  current_concerns: string[];
  questions_companion_may_ask: string[];
  material_change: boolean;
};

export type OwnerPortraitReport = {
  schema_version: "owner-context-v1";
  mode: "owner-portrait";
  portrait_signals: Array<{ dimension: string; observation: string; confidence: string; evidence_count: number; observed_across_projects: number }>;
  contradictions: string[];
  insufficient_evidence: string[];
};
