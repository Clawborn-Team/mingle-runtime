import { describe, it, expect } from "vitest";
import { WAKE_FIXTURES, WAKE_FIXTURES_VERSION } from "./fixtures/wake-fixtures.shared.js";
import { deriveConversation } from "../src/protocol/wake-adapter.js";

/**
 * Cross-repo Wake Packet conformance (Codex P1-2). We run the SAME canonical
 * fixture set im-server + mingle-hosted-agent run through OUR adapter and assert
 * the same conversation scope + reply target — so the three never drift.
 *
 * The pinned version below is the drift guard: if the shared file's version
 * changes, this fails and we must re-copy `wake-fixtures.shared.ts` verbatim.
 */
const PINNED_VERSION = "2026-07-19.1";

describe("shared Wake Packet fixtures (cross-repo contract)", () => {
  it("is pinned to the published contract version (drift guard)", () => {
    expect(WAKE_FIXTURES_VERSION).toBe(PINNED_VERSION);
  });

  for (const fixture of WAKE_FIXTURES) {
    it(`derives the right conversation for: ${fixture.name}`, () => {
      // A heartbeat has no event → no conversation; otherwise derive from the raw event.
      const convo = fixture.heartbeat || !fixture.event ? undefined : deriveConversation(fixture.event);

      if (fixture.expect === null) {
        expect(convo).toBeUndefined();
        return;
      }
      expect(convo).toBeTruthy();
      expect(convo!.scope).toBe(fixture.expect.scope);
      expect(convo!.scope_id).toBe(fixture.expect.scope_id);
      expect(convo!.reply_target).toEqual(fixture.expect.reply_target);
    });
  }
});
