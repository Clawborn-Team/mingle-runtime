import { describe, it, expect } from "vitest";
import { describeInstall, ALL_RUNTIME_KINDS } from "../src/install/describe.js";
import { bindingsFromArgs } from "../src/install/config.js";

describe("describeInstall (unified, honest install facts §9.1)", () => {
  it("describes each runtime kind", () => {
    for (const kind of ALL_RUNTIME_KINDS) {
      const d = describeInstall(kind);
      expect(d.kind).toBe(kind);
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.summary.length).toBeGreaterThan(0);
    }
  });

  it("uses the REAL driver model, never the stale 'headless / 常驻连接器' language", () => {
    const all = ALL_RUNTIME_KINDS.map((k) => JSON.stringify(describeInstall(k))).join(" ");
    expect(all).not.toContain("headless");
    expect(all).not.toContain("常驻连接器");
    expect(all).not.toContain("codex exec");
    expect(all).not.toContain("claude -p");
  });

  it("codex install names the App Server + persistent resumable sessions", () => {
    const d = describeInstall("codex");
    const text = JSON.stringify(d);
    expect(text).toContain("App Server");
    expect(text.toLowerCase()).toMatch(/resum|persist/);
  });

  it("claude install surfaces real auth honestly (no claude.ai subscription claim)", () => {
    const d = describeInstall("claude-code");
    const text = JSON.stringify(d).toLowerCase();
    expect(text).toContain("agent sdk");
    expect(text).not.toContain("claude.ai");
    expect(text).not.toContain("subscription");
    // names at least one real auth path
    expect(text).toMatch(/anthropic api key|bedrock|vertex/);
    expect(Array.isArray(d.auth)).toBe(true);
  });

  it("openclaw install describes the Gateway adapter (not a re-spawned CLI)", () => {
    const d = describeInstall("openclaw");
    const text = JSON.stringify(d).toLowerCase();
    expect(text).toContain("gateway");
    expect(text).not.toContain("scrape");
  });

  it("lists workbuddy as an installable runtime with honest copy", () => {
    expect(ALL_RUNTIME_KINDS).toContain("workbuddy");
    const d = describeInstall("workbuddy");
    expect(d.label).toBe("WorkBuddy");
    expect(d.summary.length).toBeGreaterThan(0);
  });

  it("parses --runtime workbuddy into a binding", () => {
    const [b] = bindingsFromArgs(["--agent", "a1", "--key", "k", "--im-url", "http://x", "--runtime", "workbuddy"]);
    expect(b.runtimeKind).toBe("workbuddy");
    expect(b.consumerId).toBe("mingle-runtime-a1-workbuddy");
  });
});
