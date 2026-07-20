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

  it("fingerprints normalized content deterministically", () => {
    const sessions = [{ provider: "codex" as const, sessionId: "s", project: "a", updatedAt: "x", messages: [{ role: "user" as const, text: "hi" }] }];
    expect(fingerprintSessions(sessions)).toBe(fingerprintSessions(structuredClone(sessions)));
  });
});
