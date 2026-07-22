import { describe, expect, it } from "vitest";
import { fingerprintSessions } from "../../src/owner-context/fingerprint.js";
import { sanitizeSessions } from "../../src/owner-context/redact.js";

describe("local session sanitation", () => {
  it("redacts credentials and absolute paths, drops tool/log/diff noise, and bounds input", () => {
    const clean = sanitizeSessions([{ provider: "claude-code", sessionId: "s", project: "alpha", updatedAt: "2026-07-20", messages: [
      { role: "user", text: "work in /Users/diyi/secret with ANTHROPIC_API_KEY=sk-ant-1234567890" },
      { role: "tool", text: "npm log" },
      { role: "assistant", text: "diff --git a/a b/a\n" + "+x\n".repeat(10000) },
      { role: "assistant", text: "decided to ship" },
    ] }], { maxTotalChars: 500 });
    const text = JSON.stringify(clean);
    expect(text).not.toContain("/Users/diyi");
    expect(text).not.toContain("sk-ant-");
    expect(text).not.toContain("npm log");
    expect(text).toContain("decided to ship");
    expect(text.length).toBeLessThan(900);
  });

  it("strips the runtime's OWN injected wake/persona/owner-context preambles before budgeting", () => {
    // A codex thread echoes back the runtime's injected wake input as a user message.
    // That runtime-authored text must not eat the char budget meant for real owner work.
    const injectedWake =
      "## Who you are\nYou are the owner's Local Agent.\n\n" +
      "[Mingle wake · agent a1 (local) · trace t-1]\n\n" +
      "## Owner context refresh — execute the mingle-owner-context Skill\n" +
      "This is an owner-initiated private task. Return only an owner-context-v1 JSON report.";
    const realWork = "Let's finalize the pricing model for the paid Service Agents tier.";
    const clean = sanitizeSessions([{ provider: "codex", sessionId: "s", project: "alpha", updatedAt: "2026-07-20", messages: [
      { role: "user", text: injectedWake },
      { role: "assistant", text: realWork },
    ] }], { maxTotalChars: 200 });
    const text = JSON.stringify(clean);
    expect(text).not.toContain("Who you are");
    expect(text).not.toContain("Mingle wake");
    expect(text).not.toContain("Owner context refresh");
    // Real owner content survives the (now un-crowded) budget.
    expect(text).toContain("pricing model");
  });

  it("strips the injected preamble even when the owner-authored persona is MULTI-PARAGRAPH (P1-5)", () => {
    // Real personas (Codex AGENTS.md, Claude agent files) inserted VERBATIM by the
    // renderer contain blank lines / multiple paragraphs. The matcher must not stop at
    // the first blank line inside the persona — it must scan forward to the banner.
    const persona =
      "You are the owner's Local Agent.\n" +
      "\n" +
      "You keep the owner's private data local and only surface distilled context.\n" +
      "\n" +
      "Be concise. Never expose transcripts, credentials, or paths.";
    const injectedWake =
      "## Who you are\n" + persona + "\n\n" +
      "[Mingle wake · agent a1 (local) · trace t-mp]\n\n" +
      "## Owner context refresh — execute the mingle-owner-context Skill\n" +
      "This is an owner-initiated private task. Return only an owner-context-v1 JSON report.";
    const realWork = "Let's finalize the pricing model for the paid Service Agents tier.";
    const clean = sanitizeSessions([{ provider: "codex", sessionId: "s", project: "alpha", updatedAt: "2026-07-20", messages: [
      { role: "user", text: injectedWake },
      { role: "assistant", text: realWork },
    ] }], { maxTotalChars: 200 });
    const text = JSON.stringify(clean);
    // The WHOLE injected preamble (persona body + banner + section) is gone, not just its head.
    expect(text).not.toContain("Who you are");
    expect(text).not.toContain("Mingle wake");
    expect(text).not.toContain("Owner context refresh");
    expect(text).not.toContain("keep the owner's private data local");
    // Real owner content survives the (now un-crowded) budget.
    expect(text).toContain("pricing model");
  });

  it("keeps an assistant/owner message that merely QUOTES a wake banner with real content after it (P1-5)", () => {
    // Debugging/quoting a Mingle wake banner inside a real message must NOT nuke the
    // surrounding owner decision — the unanchored INJECTED_WAKE marker used to.
    const quoting =
      "I noticed the runtime sent `[Mingle wake · agent a1 (local) · trace t-9]` earlier.\n" +
      "Decision: we ship the paid Service Agents tier at 9.9/month next sprint.";
    const clean = sanitizeSessions([{ provider: "codex", sessionId: "s", project: "alpha", updatedAt: "2026-07-20", messages: [
      { role: "assistant", text: quoting },
    ] }]);
    const text = JSON.stringify(clean);
    expect(text).toContain("Service Agents tier at 9.9");
  });

  it("keeps a real owner/assistant message that merely CONTAINS an injected heading line (P1-5)", () => {
    // A `/m`-anchored `## Who you are` / `## Heartbeat` line inside genuine content used
    // to drop the WHOLE message. It must survive.
    const whoContent = "Notes on persona work:\n## Who you are\nWe redefined the Local Agent as private-only.";
    const heartbeatContent = "Cron plan:\n## Heartbeat — every 15 min we poll the digest and log it.";
    const clean = sanitizeSessions([{ provider: "codex", sessionId: "s", project: "alpha", updatedAt: "2026-07-20", messages: [
      { role: "user", text: whoContent },
      { role: "assistant", text: heartbeatContent },
    ] }]);
    const text = JSON.stringify(clean);
    expect(text).toContain("redefined the Local Agent");
    expect(text).toContain("Cron plan");
  });

  it("still strips a genuine pure-injected user preamble that STARTS with the rendered envelope (P1-5)", () => {
    const injectedWake =
      "## Who you are\nYou are the owner's Local Agent.\n\n" +
      "[Mingle wake · agent a1 (local) · trace t-1]\n\n" +
      "## Immediate event — handle this now\n- type: dm.message.created";
    const clean = sanitizeSessions([{ provider: "codex", sessionId: "s", project: "alpha", updatedAt: "2026-07-20", messages: [
      { role: "user", text: injectedWake },
      { role: "assistant", text: "real answer here" },
    ] }]);
    const text = JSON.stringify(clean);
    expect(text).not.toContain("Who you are");
    expect(text).not.toContain("Immediate event");
    expect(text).toContain("real answer here");
  });

  it("strips a pure-injected user preamble that starts at the wake banner (no persona block) (P1-5)", () => {
    const injected =
      "[Mingle wake · agent a1 (local) · trace t-2]\n\n" +
      "## Heartbeat — periodic wake, no immediate event\nThere is no new DM to answer.";
    const clean = sanitizeSessions([{ provider: "codex", sessionId: "s", project: "alpha", updatedAt: "2026-07-20", messages: [
      { role: "user", text: injected },
      { role: "assistant", text: "keep me" },
    ] }]);
    const text = JSON.stringify(clean);
    expect(text).not.toContain("Mingle wake");
    expect(text).not.toContain("Heartbeat — periodic");
    expect(text).toContain("keep me");
  });

  it("fingerprints normalized content deterministically", () => {
    const sessions = [{ provider: "codex" as const, sessionId: "s", project: "a", updatedAt: "x", messages: [{ role: "user" as const, text: "hi" }] }];
    expect(fingerprintSessions(sessions)).toBe(fingerprintSessions(structuredClone(sessions)));
  });
});
