import { describe, it, expect } from "vitest";
import { renderWakeInput } from "../src/runtime/wake-render.js";
import { parseWakePacket } from "../src/protocol/wake-packet.js";
import {
  dmWakePacket,
  channelMentionWakePacket,
  heartbeatWakePacket,
  heartbeatWithNotificationsPacket,
} from "./fixtures/wake-packets.js";

describe("renderWakeInput (P1-5 — one trusted Wake Packet → provider input)", () => {
  it("renders a DM: immediate event + sender + reply target, no fake command", () => {
    const text = renderWakeInput(parseWakePacket(dmWakePacket));
    // the actual message body is present
    expect(text).toContain("hi 小龙");
    // source metadata preserved
    expect(text).toContain("dm.message.created");
    expect(text).toContain("bob"); // sender
    // reply destination stated
    expect(text).toContain("dm:p1");
    // it is NOT reduced to just the body
    expect(text).not.toBe("hi 小龙");
  });

  it("renders a channel @-mention: channel scope + reply target preserved", () => {
    const text = renderWakeInput(parseWakePacket(channelMentionWakePacket));
    expect(text).toContain("@小龙 一起爬山吗");
    expect(text).toContain("channel.mention.created");
    expect(text).toContain("channel:ch9");
    // the channel is the reply destination
    expect(text.toLowerCase()).toContain("channel");
  });

  it("renders a heartbeat as context, NOT the literal string (heartbeat)", () => {
    const text = renderWakeInput(parseWakePacket(heartbeatWakePacket));
    expect(text).not.toBe("(heartbeat)");
    // it explains this is a periodic wake with no immediate event
    expect(text.toLowerCase()).toContain("heartbeat");
    expect(text).toMatch(/no (immediate |new )?event|nothing immediate|periodic/i);
  });

  it("includes notifications as CONTEXT, explicitly not user commands", () => {
    const text = renderWakeInput(parseWakePacket(heartbeatWithNotificationsPacket));
    // notification content surfaces
    expect(text).toContain("找搭子");
    expect(text).toContain("carol");
    // and is framed as background context / not a command
    expect(text.toLowerCase()).toMatch(/context|background|not (a )?command|not instructions/);
  });

  it("separates the immediate event section from the notifications section", () => {
    const text = renderWakeInput(parseWakePacket(heartbeatWithNotificationsPacket));
    // two distinct labelled regions so the model can tell them apart
    expect(text).toMatch(/notification|background|activity/i);
  });

  it("carries the trace id for correlation", () => {
    const text = renderWakeInput(parseWakePacket(dmWakePacket));
    expect(text).toContain("trace-1");
  });
});
