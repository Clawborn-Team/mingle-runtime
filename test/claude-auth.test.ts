import { describe, it, expect } from "vitest";
import { detectClaudeAuth } from "../src/claude/auth.js";

describe("detectClaudeAuth (§5.5 auth honesty)", () => {
  it("reports the Anthropic API key method when ANTHROPIC_API_KEY is set", () => {
    const probe = detectClaudeAuth({ ANTHROPIC_API_KEY: "sk-ant-xxx" });
    expect(probe.available).toBe(true);
    const methods = probe.auth!.map((a) => a.method);
    expect(methods).toContain("anthropic-api-key");
    expect(probe.auth!.find((a) => a.method === "anthropic-api-key")?.ok).toBe(true);
  });

  it("reports Bedrock when CLAUDE_CODE_USE_BEDROCK is set", () => {
    const probe = detectClaudeAuth({ CLAUDE_CODE_USE_BEDROCK: "1" });
    expect(probe.available).toBe(true);
    expect(probe.auth!.map((a) => a.method)).toContain("bedrock");
  });

  it("reports Vertex when CLAUDE_CODE_USE_VERTEX is set", () => {
    const probe = detectClaudeAuth({ CLAUDE_CODE_USE_VERTEX: "1" });
    expect(probe.available).toBe(true);
    expect(probe.auth!.map((a) => a.method)).toContain("vertex");
  });

  it("is honest when no auth is configured — unavailable, no claude.ai claim", () => {
    const probe = detectClaudeAuth({});
    expect(probe.available).toBe(false);
    // must NOT imply claude.ai subscription reuse anywhere in the surfaced text
    const text = JSON.stringify(probe).toLowerCase();
    expect(text).not.toContain("claude.ai");
    expect(text).not.toContain("subscription");
    // and it should name the real options the user can set
    expect(text).toContain("anthropic_api_key");
  });
});
