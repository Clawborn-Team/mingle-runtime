import { describe, it, expect } from "vitest";
import { runBindingOnce, processWake, type EventCenterClient, type UpdatesResult, type Binding } from "../src/runtime/consumer.js";
import { InMemorySessionRegistry } from "../src/runtime/session-registry.js";
import { FakeDriver } from "../src/runtime/fake-driver.js";
import { parseWakePacket } from "../src/protocol/wake-packet.js";
import { channelMentionWakePacket, channelRawEventNoSlug, dmRawEvent } from "./fixtures/wake-packets.js";

function fakeIm(batches: UpdatesResult[]) {
  const queue = [...batches];
  const acked: string[] = [];
  const nacked: { id: string; reason: string }[] = [];
  const dms: { to: string; body: string }[] = [];
  const posts: { channel: string; body: string }[] = [];
  const im: EventCenterClient & {
    acked: string[];
    nacked: typeof nacked;
    dms: typeof dms;
    posts: typeof posts;
  } = {
    acked,
    nacked,
    dms,
    posts,
    async getUpdates() {
      return queue.shift() ?? { events: [] };
    },
    async ack(ids) {
      acked.push(...ids);
    },
    async nack(id, reason) {
      nacked.push({ id, reason });
    },
    async sendDm(to, body) {
      dms.push({ to, body });
      return { ok: true, status: 201 };
    },
    async postToChannel(channel, body) {
      posts.push({ channel, body });
      return { ok: true, status: 201 };
    },
  };
  return im;
}

const binding: Binding = { bindingId: "b1", agentAccountId: "a1", ownerAccountId: "o1", runtimeKind: "codex" };

describe("reply-target delivery (P1-3)", () => {
  it("posts a channel-scoped reply back to the originating channel", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ reply: "我也想去！" });
    const im = fakeIm([]);
    const packet = parseWakePacket(channelMentionWakePacket);

    const result = await processWake({ packet, binding, driver, registry, imClient: im });

    expect(result.scopeKey).toBe("channel:ch9");
    // reply went to the channel BY SLUG (im-server posts to /v1/channels/:slug), not the id
    expect(im.posts).toEqual([{ channel: "找搭子", body: "我也想去！" }]);
    expect(im.dms).toEqual([]);
  });

  it("resumes the SAME channel session on a follow-up wake (no new session)", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver();
    const im = fakeIm([]);
    const packet = parseWakePacket(channelMentionWakePacket);

    await processWake({ packet, binding, driver, registry, imClient: im });
    const first = (await registry.get("b1", "channel:ch9"))?.providerSessionId;
    await processWake({ packet, binding, driver, registry, imClient: im });
    const second = (await registry.get("b1", "channel:ch9"))?.providerSessionId;

    expect(second).toBe(first);
    expect(driver.openedScopes).toEqual(["channel:ch9"]); // opened once, then resumed
  });

  it("NACKs a channel wake with no recoverable slug instead of silently ACKing (P1-3)", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ reply: "done" });
    const im = fakeIm([{ events: [channelRawEventNoSlug] }]);

    await runBindingOnce({ binding, driver, registry, imClient: im });

    // the turn "succeeded" but the reply could not be routed (no slug) → NACK, not ACK
    expect(im.nacked.map((n) => n.id)).toEqual(["e_ch_noslug"]);
    expect(im.acked).not.toContain("e_ch_noslug");
    expect(im.dms).toEqual([]);
    expect(im.posts).toEqual([]);
  });

  it("NACKs (does NOT ACK) when the DM send itself fails — the reply must not vanish (P0-b)", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ reply: "hi" });
    const im = fakeIm([{ events: [dmRawEvent] }]);
    // Make the DM send fail (e.g. 403/500).
    im.sendDm = async () => ({ ok: false, status: 500 });

    await runBindingOnce({ binding, driver, registry, imClient: im });

    expect(im.nacked.map((n) => n.id)).toEqual(["e1"]);
    expect(im.acked).not.toContain("e1");
  });
});
