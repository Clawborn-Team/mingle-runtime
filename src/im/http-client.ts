/**
 * Real HTTP EventCenterClient (spec §4, §5.1) — the runtime daemon's link to
 * im-server. Implements the `EventCenterClient` the consumer loop expects
 * (getUpdates / ack / nack / sendDm / postToChannel) over im-server's public API,
 * authed as the agent with its api-key (Bearer) + a stable consumer id
 * (X-Mingle-Consumer-ID, single-active-consumer). Endpoints verified against
 * im-server: `/v1/event-center/{updates,ack,nack}`, `/v1/messages`,
 * `/v1/channels/:slug/messages`. Learned from openclaw-mingle's ImClient +
 * mingle-hosted-agent's channel-post discipline; re-implemented, nothing imported.
 */
import type { EventCenterClient, UpdatesResult } from "../runtime/consumer.js";
import { RUNTIME_NAME, RUNTIME_VERSION, RUNTIME_CAPABILITIES } from "../version.js";

export type HttpClientConfig = {
  imUrl: string;
  key: string;
  consumerId: string;
  fetchImpl?: typeof fetch;
};

export function createHttpEventCenterClient(cfg: HttpClientConfig): EventCenterClient {
  const doFetch = cfg.fetchImpl ?? fetch;
  const base = cfg.imUrl.replace(/\/+$/, "");
  const auth = { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" };
  // Runtime identity for the auto-update handshake: im-server compares the version
  // to its rollout target and returns a runtime.update directive when we're behind.
  const consumerHeaders = {
    ...auth,
    "X-Mingle-Consumer-ID": cfg.consumerId,
    "X-Mingle-Runtime": RUNTIME_NAME,
    "X-Mingle-Runtime-Version": RUNTIME_VERSION,
    "X-Mingle-Runtime-Capabilities": RUNTIME_CAPABILITIES.join(","),
  };

  async function postChannel(slug: string, body: string): Promise<{ ok: boolean; status: number }> {
    const url = `${base}/v1/channels/${encodeURIComponent(slug)}/messages`;
    const res = await doFetch(url, { method: "POST", headers: auth, body: JSON.stringify({ body }) });
    return { ok: res.status === 201, status: res.status };
  }

  return {
    async getUpdates({ cursor, wait = 25000, digest = false }): Promise<UpdatesResult> {
      const qs = new URLSearchParams({ wait: String(wait) });
      if (cursor) qs.set("cursor", cursor);
      if (digest) qs.set("digest", "true"); // return pending notifications even with no wake event
      const res = await doFetch(`${base}/v1/event-center/updates?${qs}`, { headers: consumerHeaders });
      const json = (await res.json().catch(() => ({}))) as {
        events?: unknown[];
        notifications?: unknown[];
        next_cursor?: string;
        runtime_directives?: unknown[];
      };
      return {
        events: (json.events ?? []) as UpdatesResult["events"],
        notifications: (json.notifications ?? []) as UpdatesResult["notifications"],
        next_cursor: json.next_cursor,
        runtime_directives: (json.runtime_directives ?? []) as UpdatesResult["runtime_directives"],
      };
    },

    async ack(eventIds) {
      if (eventIds.length === 0) return;
      await doFetch(`${base}/v1/event-center/ack`, {
        method: "POST",
        headers: consumerHeaders,
        body: JSON.stringify({ event_ids: eventIds, notification_ids: [] }),
      });
    },

    async nack(eventId, reason) {
      const res = await doFetch(`${base}/v1/event-center/nack`, {
        method: "POST",
        headers: consumerHeaders,
        body: JSON.stringify({ event_id: eventId, reason }),
      });
      if (res.status !== 200) {
        const json = (await res.json().catch(() => ({}))) as unknown;
        throw new Error(`nack failed: ${res.status} ${JSON.stringify(json)}`);
      }
    },

    async sendDm(to, body) {
      const res = await doFetch(`${base}/v1/messages`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ to, body }),
      });
      return { ok: res.status === 201, status: res.status };
    },

    async postActivity(peerId, state, detail) {
      // Best-effort ephemeral presence; never let it break a turn.
      try {
        await doFetch(`${base}/v1/activity`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify({ peer_id: peerId, state, ...(detail ? { detail } : {}) }),
        });
      } catch {
        /* ignore */
      }
    },

    /** Post a reply to a channel by slug. If we're not a member yet (403), join
     *  once and retry — mirrors mingle-hosted-agent's proven channel-reply path. */
    async postToChannel(slug, body) {
      const first = await postChannel(slug, body);
      if (first.status !== 403) return first;
      const joined = await doFetch(`${base}/v1/channels/${encodeURIComponent(slug)}/join`, {
        method: "POST",
        headers: auth,
      });
      if (joined.status < 200 || joined.status >= 300) return first;
      return postChannel(slug, body);
    },
  };
}
