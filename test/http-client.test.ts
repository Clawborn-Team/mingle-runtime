import { describe, it, expect } from "vitest";
import { createHttpEventCenterClient } from "../src/im/http-client.js";

type Call = { url: string; init?: RequestInit };

/** A fetch double that records calls and returns scripted responses per URL suffix. */
function fakeFetch(routes: Record<string, { status: number; body?: unknown }>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const key = Object.keys(routes).find((k) => u.includes(k));
    const r = key ? routes[key]! : { status: 404, body: {} };
    return {
      status: r.status,
      json: async () => r.body ?? {},
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const base = { imUrl: "https://relay.test/", key: "k_secret", consumerId: "mingle-runtime-a-codex" };

describe("HttpEventCenterClient", () => {
  it("getUpdates issues a Bearer + consumer-id long-poll and parses events/next_cursor", async () => {
    const rawEvent = { id: "e1", type: "dm.message.created", payload: { conversation: { peer_id: "p1" } } };
    const { impl, calls } = fakeFetch({
      "/v1/event-center/updates": { status: 200, body: { events: [rawEvent], next_cursor: "c2" } },
    });
    const client = createHttpEventCenterClient({ ...base, fetchImpl: impl });
    const res = await client.getUpdates({ cursor: "c1", wait: 1000 });
    // returns the raw {id,type,payload} events verbatim — the consumer builds the packet
    expect(res).toEqual({ events: [rawEvent], notifications: [], next_cursor: "c2" });
    const call = calls[0]!;
    expect(call.url).toContain("/v1/event-center/updates");
    expect(call.url).toContain("wait=1000");
    expect(call.url).toContain("cursor=c1");
    const headers = call.init!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer k_secret");
    expect(headers["X-Mingle-Consumer-ID"]).toBe("mingle-runtime-a-codex");
  });

  it("getUpdates tolerates a missing body (empty events)", async () => {
    const { impl } = fakeFetch({ "/v1/event-center/updates": { status: 200 } });
    const client = createHttpEventCenterClient({ ...base, fetchImpl: impl });
    expect(await client.getUpdates({})).toEqual({ events: [], notifications: [], next_cursor: undefined });
  });

  it("ack POSTs event_ids (no-op on empty)", async () => {
    const { impl, calls } = fakeFetch({ "/v1/event-center/ack": { status: 200 } });
    const client = createHttpEventCenterClient({ ...base, fetchImpl: impl });
    await client.ack([]);
    expect(calls).toHaveLength(0); // empty ack makes no request
    await client.ack(["e1", "e2"]);
    const call = calls[0]!;
    expect(call.url).toContain("/v1/event-center/ack");
    expect(JSON.parse(call.init!.body as string)).toEqual({ event_ids: ["e1", "e2"], notification_ids: [] });
  });

  it("nack POSTs {event_id, reason} and throws on non-200", async () => {
    const okFetch = fakeFetch({ "/v1/event-center/nack": { status: 200, body: { state: "backoff" } } });
    const okClient = createHttpEventCenterClient({ ...base, fetchImpl: okFetch.impl });
    await okClient.nack("e1", "provider crashed");
    expect(JSON.parse(okFetch.calls[0]!.init!.body as string)).toEqual({ event_id: "e1", reason: "provider crashed" });

    const badFetch = fakeFetch({ "/v1/event-center/nack": { status: 404, body: {} } });
    const badClient = createHttpEventCenterClient({ ...base, fetchImpl: badFetch.impl });
    await expect(badClient.nack("e1", "x")).rejects.toThrow(/nack/);
  });

  it("sendDm POSTs {to, body} to /v1/messages and reports ok on 201", async () => {
    const { impl, calls } = fakeFetch({ "/v1/messages": { status: 201 } });
    const client = createHttpEventCenterClient({ ...base, fetchImpl: impl });
    const r = await client.sendDm("acc_peer", "hi");
    expect(r).toEqual({ ok: true, status: 201 });
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ to: "acc_peer", body: "hi" });
  });

  it("postToChannel posts to /v1/channels/<slug>/messages", async () => {
    const { impl, calls } = fakeFetch({ "/messages": { status: 201 } });
    const client = createHttpEventCenterClient({ ...base, fetchImpl: impl });
    const r = await client.postToChannel("lobby", "hey");
    expect(r).toEqual({ ok: true, status: 201 });
    expect(calls[0]!.url).toContain("/v1/channels/lobby/messages");
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ body: "hey" });
  });

  it("postToChannel auto-joins then retries once on not_member (403)", async () => {
    let posts = 0;
    const impl = (async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/messages")) {
        posts++;
        return { status: posts === 1 ? 403 : 201, json: async () => ({ error: { code: "not_member" } }) } as Response;
      }
      if (u.includes("/join")) return { status: 200, json: async () => ({}) } as Response;
      return { status: 404, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    const client = createHttpEventCenterClient({ ...base, fetchImpl: impl });
    const r = await client.postToChannel("team", "hi");
    expect(r.ok).toBe(true);
    expect(posts).toBe(2); // first 403 → join → retry → 201
  });
});
