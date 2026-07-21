import { describe, it, expect } from "vitest";
import { resolveDriver, driverCapabilities } from "../src/runtime/driver-registry.js";
import { FakeGateway } from "../src/openclaw/gateway.js";
import { fakeClaudeQuery } from "../src/claude/fake-query.js";

describe("driver registry", () => {
  it("resolves the OpenClaw driver", () => {
    const d = resolveDriver("openclaw", { openclaw: { gateway: new FakeGateway() } });
    expect(d.kind).toBe("openclaw");
  });

  it("resolves the Claude driver", () => {
    const d = resolveDriver("claude-code", { claude: { query: fakeClaudeQuery(), cwd: "/tmp" } });
    expect(d.kind).toBe("claude-code");
  });

  it("throws a clear error when a driver's deps are missing", () => {
    expect(() => resolveDriver("codex", {})).toThrow(/codex/i);
    expect(() => resolveDriver("claude-code", {})).toThrow(/claude/i);
    expect(() => resolveDriver("openclaw", {})).toThrow(/openclaw/i);
  });

  it("exposes each kind's capabilities for honest UI degrade", () => {
    // OpenClaw does not stream token deltas; Codex/Claude do.
    expect(driverCapabilities("openclaw").streaming).toBe(false);
    expect(driverCapabilities("codex").streaming).toBe(true);
    expect(driverCapabilities("claude-code").resume).toBe(true);
  });

  it("declares honest workbuddy capabilities (no fileChanges in v1)", () => {
    expect(driverCapabilities("workbuddy")).toEqual({
      streaming: true, tools: true, approvals: true, fileChanges: false, resume: true, imageInputs: "local-file",
    });
  });
});
