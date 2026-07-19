/**
 * Shared Wake-Packet fixtures (`mingle.agent-wake.v1`). These mirror what the
 * im-server builder (`im-server/src/agent-protocol/wake-packet.ts`) emits, so the
 * runtime's parser is proven against the same schema every consumer sees (§13.1).
 */

export const dmWakePacket = {
  schema: "mingle.agent-wake.v1",
  agent: { account_id: "c1", agent_kind: "companion" },
  wake: {
    kind: "event",
    event: {
      id: "e1",
      type: "dm.message.created",
      payload: {
        conversation: { kind: "direct", peer_id: "p1", peer_username: "bob" },
        message: { id: "m1", body: "hi 小龙", seq: 7 },
      },
    },
  },
  notifications: [],
  conversation: {
    scope: "dm",
    scope_id: "dm:p1",
    peer_id: "p1",
    reply_target: { kind: "dm", peer_id: "p1" },
  },
  trace_id: "trace-1",
} as const;

/** A group/plaza @-mention wake. The channel scope + channel reply target mirror
 *  what im-server's builder emits for channel.mention.created (commit 3eec5d6). */
export const channelMentionWakePacket = {
  schema: "mingle.agent-wake.v1",
  agent: { account_id: "c1", agent_kind: "companion" },
  wake: {
    kind: "event",
    event: {
      id: "e2",
      type: "channel.mention.created",
      payload: {
        conversation: { kind: "channel", channel_id: "ch9", channel_slug: "找搭子" },
        message: { id: "m2", body: "@小龙 一起爬山吗", seq: 3, from_username: "alice" },
      },
    },
  },
  notifications: [],
  conversation: {
    scope: "channel",
    scope_id: "channel:ch9",
    channel_id: "ch9",
    reply_target: { kind: "channel", channel_id: "ch9" },
  },
  trace_id: "trace-ch",
} as const;

export const heartbeatWakePacket = {
  schema: "mingle.agent-wake.v1",
  agent: { account_id: "c1", agent_kind: "companion" },
  wake: { kind: "heartbeat" },
  notifications: [],
  trace_id: "trace-hb",
} as const;

/** A heartbeat wake that carries background notifications (group activity the
 *  Agent should treat as CONTEXT, not a command). */
export const heartbeatWithNotificationsPacket = {
  schema: "mingle.agent-wake.v1",
  agent: { account_id: "c1", agent_kind: "companion" },
  wake: { kind: "heartbeat" },
  notifications: [
    { id: "n1", type: "channel.message.created", payload: { channel_slug: "找搭子", summary: "3 条新消息" } },
    { id: "n2", type: "match.suggested", payload: { peer_username: "carol", reason: "都喜欢摄影" } },
  ],
  trace_id: "trace-hb2",
} as const;

/** A wake whose reply target kind the Runtime does not support yet (task) — the
 *  consumer must NACK, not silently ACK (P1-3 acceptance). */
export const unsupportedTargetWakePacket = {
  schema: "mingle.agent-wake.v1",
  agent: { account_id: "c1", agent_kind: "companion" },
  wake: {
    kind: "event",
    event: { id: "e7", type: "task.assigned", payload: { task: { id: "t7" }, message: { body: "do the thing" } } },
  },
  notifications: [],
  conversation: {
    scope: "task",
    scope_id: "task:t7",
    reply_target: { kind: "task", task_id: "t7" },
  },
  trace_id: "trace-task",
} as const;

/** A packet carrying a top-level field the current parser doesn't know — must be
 *  tolerated (forward-compat, §13.1). */
export const forwardCompatWakePacket = {
  ...dmWakePacket,
  future_field: { anything: true },
} as const;

/**
 * RAW Event Center events (`{id,type,payload}`) as GET /v1/event-center/updates
 * actually returns them — the runtime builds the Wake Packet from these locally.
 * Derived from the packet fixtures above so the two never drift.
 */
export const dmRawEvent = dmWakePacket.wake.event;
export const channelRawEvent = channelMentionWakePacket.wake.event;
/** A channel mention MISSING channel_slug → the runtime can derive scope but has no
 *  slug to post the reply to → delivery is "unsupported" (NACK, not a wrong post). */
export const channelRawEventNoSlug = {
  id: "e_ch_noslug",
  type: "channel.mention.created",
  payload: { conversation: { kind: "group", channel_id: "chX" }, message: { id: "m", body: "@小龙 hi", seq: 1 } },
} as const;
/** An unknown/non-actionable event type → derives no conversation → dropped + ACKed. */
export const unknownRawEvent = {
  id: "e_unknown",
  type: "some.future.event.v9",
  payload: { anything: true },
} as const;
