import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isValidOwnerContextReport } from "../../src/owner-context/validate.js";

const briefing = JSON.parse(
  readFileSync(new URL("../fixtures/owner-context-v1.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const portrait = {
  schema_version: "owner-context-v1",
  mode: "owner-portrait",
  portrait_signals: [
    { dimension: "builder", observation: "ships agent infra", confidence: "high", evidence_count: 5, observed_across_projects: 2 },
  ],
  contradictions: [],
  insufficient_evidence: ["social preferences"],
};

describe("isValidOwnerContextReport", () => {
  it("accepts the canonical recent-briefing fixture for recent-briefing mode", () => {
    expect(isValidOwnerContextReport(JSON.stringify(briefing), "recent-briefing")).toBe(true);
  });

  it("accepts a well-formed owner-portrait for owner-portrait mode", () => {
    expect(isValidOwnerContextReport(JSON.stringify(portrait), "owner-portrait")).toBe(true);
  });

  it("rejects a recent-briefing report when owner-portrait was requested (wrong mode)", () => {
    expect(isValidOwnerContextReport(JSON.stringify(briefing), "owner-portrait")).toBe(false);
  });

  it("rejects an owner-portrait report when recent-briefing was requested (wrong mode)", () => {
    expect(isValidOwnerContextReport(JSON.stringify(portrait), "recent-briefing")).toBe(false);
  });

  it("rejects a provider apology / plain prose", () => {
    expect(isValidOwnerContextReport("Sorry, I couldn't complete that.", "recent-briefing")).toBe(false);
  });

  it("rejects truncated / malformed JSON", () => {
    expect(isValidOwnerContextReport('{"schema_version":"owner-context-v1","mode":"recent-brie', "recent-briefing")).toBe(false);
  });

  it("rejects JSON with the wrong schema_version", () => {
    expect(isValidOwnerContextReport(JSON.stringify({ ...briefing, schema_version: "owner-context-v2" }), "recent-briefing")).toBe(false);
  });

  it("rejects a recent-briefing missing required fields", () => {
    const { recent_activity, ...rest } = briefing;
    void recent_activity;
    expect(isValidOwnerContextReport(JSON.stringify(rest), "recent-briefing")).toBe(false);
  });

  it("rejects empty / undefined", () => {
    expect(isValidOwnerContextReport("", "recent-briefing")).toBe(false);
    expect(isValidOwnerContextReport(undefined, "recent-briefing")).toBe(false);
  });

  it("accepts a valid no-change report (material_change=false is still a valid report)", () => {
    expect(isValidOwnerContextReport(JSON.stringify({ ...briefing, recent_activity: [], material_change: false }), "recent-briefing")).toBe(true);
  });
});
