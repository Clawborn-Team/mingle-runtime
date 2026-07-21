import { describe, it, expect } from "vitest";
import { processWake, type EventCenterClient } from "../src/runtime/consumer.js";
import { InMemorySessionRegistry } from "../src/runtime/session-registry.js";
import { ClaudeAgentDriver } from "../src/claude/driver.js";
import { fakeClaudeQuery } from "../src/claude/fake-query.js";
import { parseWakePacket } from "../src/protocol/wake-packet.js";
import { dmWakePacket, channelMentionWakePacket } from "./fixtures/wake-packets.js";

type Sent = { to: string; body: string; structured?: unknown };

function fakeIm() {
  const dms: Sent[] = [];
  const posts: Sent[] = [];
  const im: EventCenterClient & { dms: Sent[]; posts: Sent[] } = {
    dms,
    posts,
    async getUpdates() {
      return { events: [] };
    },
    async ack() {},
    async nack() {},
    async sendDm(to, body, structured) {
      dms.push({ to, body, structured });
      return { ok: true, status: 201 };
    },
    async postToChannel(slug, body, structured) {
      posts.push({ to: slug, body, structured });
      return { ok: true, status: 201 };
    },
  };
  return im;
}

const askUserQuestion = {
  name: "AskUserQuestion",
  input: {
    questions: [
      {
        question: "选哪个方案？",
        header: "方案",
        multiSelect: false,
        options: [
          { label: "方案 A", description: "更快" },
          { label: "方案 B", description: "更稳" },
        ],
      },
    ],
  },
};

function claudeAskDriver() {
  const query = fakeClaudeQuery("tool-use", { sessionId: "sess-q", toolUse: askUserQuestion });
  return new ClaudeAgentDriver({ query, cwd: "/tmp/ws" });
}

const binding = { bindingId: "b1", agentAccountId: "a1", ownerAccountId: "o1", runtimeKind: "claude-code" as const };

describe("processWake delivers a structured question when a turn raises one", () => {
  it("DM: sends ONE structured message; body is a plaintext fallback; payload carries the question block", async () => {
    const registry = new InMemorySessionRegistry();
    const im = fakeIm();
    const result = await processWake({
      packet: parseWakePacket(dmWakePacket),
      binding,
      driver: claudeAskDriver(),
      registry,
      imClient: im,
    });

    expect(result.delivery).toBe("delivered");
    expect(im.dms).toHaveLength(1);
    const sent = im.dms[0]!;
    expect(sent.body).toBe("选哪个方案？"); // non-empty plaintext fallback
    expect(sent.structured).toMatchObject({
      contentType: "structured",
      payload: {
        schema: "mingle.message.v1",
        provider: "claude-code",
        blocks: [
          {
            type: "question",
            prompt: "选哪个方案？",
            allow_multiple: false,
            status: "open",
            options: [{ label: "方案 A" }, { label: "方案 B" }],
          },
        ],
      },
    });
  });

  it("channel: posts the structured question to the channel by slug", async () => {
    const registry = new InMemorySessionRegistry();
    const im = fakeIm();
    const result = await processWake({
      packet: parseWakePacket(channelMentionWakePacket),
      binding,
      driver: claudeAskDriver(),
      registry,
      imClient: im,
    });

    expect(result.delivery).toBe("delivered");
    expect(im.posts).toHaveLength(1);
    expect(im.posts[0]!.to).toBe("找搭子"); // channel slug
    expect(im.posts[0]!.structured).toMatchObject({
      contentType: "structured",
      payload: { schema: "mingle.message.v1", blocks: [{ type: "question" }] },
    });
  });
});
