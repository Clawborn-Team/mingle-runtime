import { describe, it, expect } from "vitest";
import { deriveScopeKey } from "../src/protocol/scope.js";
import type { WakePacket } from "../src/protocol/wake-packet.js";
import { dmWakePacket, heartbeatWakePacket, channelMentionWakePacket } from "./fixtures/wake-packets.js";

function withConversation(scope: WakePacket["conversation"]): WakePacket {
  return { ...(dmWakePacket as unknown as WakePacket), conversation: scope };
}

describe("deriveScopeKey (§4.3)", () => {
  it("uses the dm scope_id from a dm wake", () => {
    expect(deriveScopeKey(dmWakePacket as unknown as WakePacket, { ownerAccountId: "o1" })).toBe("dm:p1");
  });

  it("uses the channel scope from a real group-@ wake fixture (P1-3)", () => {
    expect(deriveScopeKey(channelMentionWakePacket as unknown as WakePacket, { ownerAccountId: "o1" })).toBe(
      "channel:ch9",
    );
  });

  it("derives channel / owner / task scope keys", () => {
    expect(
      deriveScopeKey(
        withConversation({ scope: "channel", scope_id: "channel:ch9", channel_id: "ch9", reply_target: { kind: "channel", channel_id: "ch9" } }),
        { ownerAccountId: "o1" },
      ),
    ).toBe("channel:ch9");
    expect(
      deriveScopeKey(
        withConversation({ scope: "task", scope_id: "task:t3", reply_target: { kind: "task", task_id: "t3" } }),
        { ownerAccountId: "o1" },
      ),
    ).toBe("task:t3");
  });

  it("falls back to the owner scope for a heartbeat (no conversation)", () => {
    expect(deriveScopeKey(heartbeatWakePacket as unknown as WakePacket, { ownerAccountId: "o1" })).toBe("owner:o1");
  });

  it("reconstructs a scope_id when the packet omits it but has scope+ids", () => {
    // A packet that names the scope + peer but not the composed scope_id.
    const p = withConversation({ scope: "dm", scope_id: "", peer_id: "p9", reply_target: { kind: "dm", peer_id: "p9" } });
    expect(deriveScopeKey(p, { ownerAccountId: "o1" })).toBe("dm:p9");
  });
});
