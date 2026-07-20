import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { OwnerContextBriefing } from "../../src/owner-context/types.js";

describe("owner-context-v1 cross-repo fixture", () => {
  it("matches the runtime output contract", () => {
    const report = JSON.parse(readFileSync(new URL("../fixtures/owner-context-v1.json", import.meta.url), "utf8")) as OwnerContextBriefing;
    expect(report.schema_version).toBe("owner-context-v1");
    expect(report.window.days).toBe(7);
    expect(report.recent_activity[0]?.confidence).toBe("high");
    expect(report.material_change).toBe(true);
  });
});
