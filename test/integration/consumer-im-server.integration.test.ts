import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startImServer, provisionUser, createLocalAgent, sendDm, repliesFrom, type RunningServer } from "../support/im-server.js";
import { createHttpEventCenterClient } from "../../src/im/http-client.js";
import { runBindingOnce, runDigestOnce, type Binding } from "../../src/runtime/consumer.js";
import { InMemorySessionRegistry } from "../../src/runtime/session-registry.js";
import { FakeDriver } from "../../src/runtime/fake-driver.js";

/**
 * End-to-end over a REAL im-server (not fakes): the runtime's HTTP client fetches the
 * raw Event Center event, the consumer builds the wake packet + drives a turn
 * (FakeDriver, deterministic) + delivers the reply, and we read it back via the real
 * messages API. Exercises the exact seams that broke in manual testing: raw-event →
 * wake packet, from_account_id reply shape, delivery-ok.
 */
describe("runtime ↔ real im-server (integration)", () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await startImServer();
  }, 45_000);
  afterAll(async () => {
    await server?.stop();
  });

  it("delivers a codex-style reply to a DM: owner → local agent → reply back to owner", async () => {
    const owner = await provisionUser(server.url, `own_${Date.now().toString(36)}`);
    const agent = await createLocalAgent(server.url, owner.apiKey, `agt_${Date.now().toString(36)}`);
    await sendDm(server.url, owner.apiKey, agent.accountId, "你好，介绍一下自己");

    const imClient = createHttpEventCenterClient({ imUrl: server.url, key: agent.apiKey, consumerId: `it-${agent.accountId}` });
    const binding: Binding = { bindingId: `${agent.accountId}:codex`, agentAccountId: agent.accountId, ownerAccountId: agent.accountId, runtimeKind: "codex" };
    const driver = new FakeDriver({ reply: "我是你的 Mingle 本地智能体。" });
    const registry = new InMemorySessionRegistry();

    await runBindingOnce({ binding, driver, registry, imClient, wait: 2000 });

    // owner reads the thread; the agent's reply must be delivered (from_account_id = agent)
    const replies = await repliesFrom(server.url, owner.apiKey, agent.accountId, agent.accountId);
    expect(replies).toContain("我是你的 Mingle 本地智能体。");
  }, 30_000);

  it("does not double-drive: a second drain with no new event delivers nothing more", async () => {
    const owner = await provisionUser(server.url, `own2_${Date.now().toString(36)}`);
    const agent = await createLocalAgent(server.url, owner.apiKey, `agt2_${Date.now().toString(36)}`);
    await sendDm(server.url, owner.apiKey, agent.accountId, "hi");
    const imClient = createHttpEventCenterClient({ imUrl: server.url, key: agent.apiKey, consumerId: `it2-${agent.accountId}` });
    const binding: Binding = { bindingId: `${agent.accountId}:codex`, agentAccountId: agent.accountId, ownerAccountId: agent.accountId, runtimeKind: "codex" };
    const driver = new FakeDriver({ reply: "ok" });
    const registry = new InMemorySessionRegistry();

    const cursor = await runBindingOnce({ binding, driver, registry, imClient, wait: 2000 });
    await runBindingOnce({ binding, driver, registry, imClient, cursor, wait: 1000 }); // no new event

    const replies = await repliesFrom(server.url, owner.apiKey, agent.accountId, agent.accountId);
    expect(replies.filter((r) => r === "ok")).toHaveLength(1); // exactly one reply, no duplicate
  }, 30_000);

  it("digest heartbeat drives no turn when there are no pending notifications", async () => {
    const owner = await provisionUser(server.url, `own3_${Date.now().toString(36)}`);
    const agent = await createLocalAgent(server.url, owner.apiKey, `agt3_${Date.now().toString(36)}`);
    const imClient = createHttpEventCenterClient({ imUrl: server.url, key: agent.apiKey, consumerId: `it3-${agent.accountId}` });
    const binding: Binding = { bindingId: `${agent.accountId}:codex`, agentAccountId: agent.accountId, ownerAccountId: agent.accountId, runtimeKind: "codex" };
    const driver = new FakeDriver({ reply: "noted" });

    const drove = await runDigestOnce({ binding, driver, registry: new InMemorySessionRegistry(), imClient });
    expect(drove).toBe(false); // no notifications pending → no heartbeat turn
    expect(driver.openedScopes).toEqual([]);
  }, 20_000);
});
