/**
 * Honest Claude auth surfacing (spec §5.5). Anthropic's terms are explicit: an
 * unapproved third-party product must NOT default users into claude.ai login or
 * reuse its rate limits. So we detect only the REAL, supported credentials the
 * Agent SDK accepts — Anthropic API key, Amazon Bedrock, Google Vertex — and
 * report them truthfully. When none is configured we say so plainly and name the
 * env vars to set; we never imply a Claude subscription can be reused.
 *
 * Pure (env → methods), no network — so it is deterministically testable and
 * safe to call from `probe()`.
 */
import type { RuntimeProbe } from "../runtime/driver.js";

export type AuthMethod = { method: string; ok: boolean; detail?: string };

/** Inspect an environment for usable Claude Agent SDK credentials. */
export function detectClaudeAuth(env: NodeJS.ProcessEnv = process.env): RuntimeProbe {
  const auth: AuthMethod[] = [];

  if (env.ANTHROPIC_API_KEY) {
    auth.push({ method: "anthropic-api-key", ok: true, detail: "ANTHROPIC_API_KEY is set" });
  }
  if (env.CLAUDE_CODE_USE_BEDROCK === "1" || env.CLAUDE_CODE_USE_BEDROCK === "true") {
    auth.push({ method: "bedrock", ok: true, detail: "CLAUDE_CODE_USE_BEDROCK enabled" });
  }
  if (env.CLAUDE_CODE_USE_VERTEX === "1" || env.CLAUDE_CODE_USE_VERTEX === "true") {
    auth.push({ method: "vertex", ok: true, detail: "CLAUDE_CODE_USE_VERTEX enabled" });
  }

  const available = auth.length > 0;
  const probe: RuntimeProbe = {
    kind: "claude-code",
    available,
    auth,
  };
  if (!available) {
    // Name the real, supported options — no claude.ai / subscription language.
    probe.detail =
      "No Claude credentials configured. Set ANTHROPIC_API_KEY, or enable Amazon Bedrock " +
      "(CLAUDE_CODE_USE_BEDROCK=1) / Google Vertex (CLAUDE_CODE_USE_VERTEX=1).";
  }
  return probe;
}
