/**
 * Canonical Wake Packet fixtures — the CROSS-REPO contract (Codex P1-2).
 *
 * These are real `mingle.account-event-center.v1` event shapes (as the public Event
 * Center returns them) paired with the conversation scope + reply target a conformant
 * builder/adapter MUST derive. im-server, mingle-runtime, and mingle-hosted-agent each
 * run THIS SAME set through their builder/parser so the three never drift.
 *
 * To share: copy this file verbatim into the consuming repo's test tree and assert your
 * adapter produces the same `expect` for each case. Keep `WAKE_FIXTURES_VERSION` in sync;
 * a mismatch means the contract moved and every repo must re-copy.
 */

export const WAKE_FIXTURES_VERSION = "2026-07-19.1";

export type WakeFixture = {
  name: string;
  /** A raw Event Center event ({id,type,payload}) — omitted for a heartbeat wake. */
  event?: { id: string; type: string; payload?: Record<string, unknown> };
  /** true for the heartbeat wake case (no immediate event). */
  heartbeat?: boolean;
  /** The conversation the builder must derive, or null for "no conversation scope". */
  expect: {
    scope: "dm" | "channel" | "owner" | "task";
    scope_id: string;
    reply_target: Record<string, string>;
  } | null;
};

export const WAKE_FIXTURES: WakeFixture[] = [
  {
    name: "dm.message.created → dm scope",
    event: {
      id: "evt_dm_1",
      type: "dm.message.created",
      payload: {
        conversation: { kind: "direct", peer_id: "acc_peer", peer_username: "bob" },
        message: { id: "msg_1", body: "hi 小龙", seq: 7 },
      },
    },
    expect: { scope: "dm", scope_id: "dm:acc_peer", reply_target: { kind: "dm", peer_id: "acc_peer" } },
  },
  {
    name: "channel.mention.created (group) → channel scope",
    event: {
      id: "evt_ch_1",
      type: "channel.mention.created",
      payload: {
        conversation: { kind: "group", channel_id: "ch_1", channel_slug: "lobby", channel_name: "Lobby" },
        message: { id: "cm_1", body: "@小龙 在吗", seq: 12 },
      },
    },
    expect: { scope: "channel", scope_id: "channel:ch_1", reply_target: { kind: "channel", channel_id: "ch_1" } },
  },
  {
    name: "channel.followup.created (attention window) → channel scope",
    event: {
      id: "evt_ch_2",
      type: "channel.followup.created",
      payload: {
        conversation: { kind: "group", channel_id: "ch_2", channel_slug: "team" },
        attention: { reason: "active_group_conversation", read_recent_context: true },
      },
    },
    expect: { scope: "channel", scope_id: "channel:ch_2", reply_target: { kind: "channel", channel_id: "ch_2" } },
  },
  {
    name: "channel.mention.created (plaza) → channel scope",
    event: {
      id: "evt_plaza_1",
      type: "channel.mention.created",
      payload: {
        conversation: { kind: "plaza", channel_id: "ch_plaza", channel_slug: "plaza", channel_name: "广场" },
        message: { id: "pm_1", body: "@小龙 hi", seq: 3 },
      },
    },
    expect: { scope: "channel", scope_id: "channel:ch_plaza", reply_target: { kind: "channel", channel_id: "ch_plaza" } },
  },
  {
    name: "heartbeat wake → no conversation scope",
    heartbeat: true,
    expect: null,
  },
  {
    name: "unknown future event type → no conversation scope (forward-compat)",
    event: { id: "evt_future", type: "some.future.event.v9", payload: { anything: true } },
    expect: null,
  },
  {
    name: "unknown field on a known event is tolerated (forward-compat)",
    event: {
      id: "evt_dm_2",
      type: "dm.message.created",
      payload: {
        conversation: { kind: "direct", peer_id: "acc_peer2", brand_new_field: "ignore me" },
        message: { id: "msg_2", body: "hi", seq: 9, another_new_field: 1 },
      },
    },
    expect: { scope: "dm", scope_id: "dm:acc_peer2", reply_target: { kind: "dm", peer_id: "acc_peer2" } },
  },
];
