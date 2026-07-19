import { describe, it, expect } from "vitest";
import { runBindingOnce, processWake, type EventCenterClient, type UpdatesResult, type Binding } from "../src/runtime/consumer.js";
import { InMemorySessionRegistry } from "../src/runtime/session-registry.js";
import { FakeDriver } from "../src/runtime/fake-driver.js";
import { parseWakePacket } from "../src/protocol/wake-packet.js";
import { channelMentionWakePacket, unsupportedTargetWakePacket } from "./fixtures/wake-packets.js";

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
    // reply went to the channel, not a DM
    expect(im.posts).toEqual([{ channel: "ch9", body: "我也想去！" }]);
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

  it("NACKs an unsupported reply target instead of silently ACKing (P1-3 acceptance)", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ reply: "done" });
    const im = fakeIm([{ events: [{ id: "e7", packet: unsupportedTargetWakePacket }] }]);

    await runBindingOnce({ binding, driver, registry, imClient: im });

    // the turn "succeeded" but the reply could not be delivered → NACK, not ACK
    expect(im.nacked.map((n) => n.id)).toEqual(["e7"]);
    expect(im.acked).not.toContain("e7");
    expect(im.dms).toEqual([]);
    expect(im.posts).toEqual([]);
  });
});
