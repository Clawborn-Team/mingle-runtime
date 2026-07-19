import { describe, it, expect } from "vitest";
import { parseWakePacket, WAKE_PACKET_SCHEMA } from "../src/protocol/wake-packet.js";
import { dmWakePacket, heartbeatWakePacket, forwardCompatWakePacket } from "./fixtures/wake-packets.js";

describe("parseWakePacket", () => {
  it("parses the shared dm fixture and preserves structured event/notifications", () => {
    const p = parseWakePacket(dmWakePacket);
    expect(p.schema).toBe(WAKE_PACKET_SCHEMA);
    expect(p.wake.kind).toBe("event");
    // the event stays a structured object, not restringified (§13.1)
    expect(p.wake.event?.type).toBe("dm.message.created");
    expect((p.wake.event?.payload as any).message.body).toBe("hi 小龙");
    expect(p.conversation?.scope_id).toBe("dm:p1");
    expect(Array.isArray(p.notifications)).toBe(true);
  });

  it("parses a heartbeat wake with no conversation", () => {
    const p = parseWakePacket(heartbeatWakePacket);
    expect(p.wake.kind).toBe("heartbeat");
    expect(p.wake.event).toBeUndefined();
    expect(p.conversation).toBeUndefined();
  });

  it("tolerates unknown top-level fields (forward-compat)", () => {
    const p = parseWakePacket(forwardCompatWakePacket);
    expect(p.schema).toBe(WAKE_PACKET_SCHEMA);
    expect(p.conversation?.scope).toBe("dm");
  });

  it("rejects a packet with the wrong schema", () => {
    expect(() => parseWakePacket({ ...dmWakePacket, schema: "something.else" })).toThrow(/schema/i);
  });

  it("rejects a non-object / missing agent", () => {
    expect(() => parseWakePacket(null)).toThrow();
    expect(() => parseWakePacket({ schema: WAKE_PACKET_SCHEMA, wake: { kind: "heartbeat" } })).toThrow(/agent/i);
  });
});
