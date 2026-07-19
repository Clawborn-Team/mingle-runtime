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

export const heartbeatWakePacket = {
  schema: "mingle.agent-wake.v1",
  agent: { account_id: "c1", agent_kind: "companion" },
  wake: { kind: "heartbeat" },
  notifications: [],
  trace_id: "trace-hb",
} as const;

/** A packet carrying a top-level field the current parser doesn't know — must be
 *  tolerated (forward-compat, §13.1). */
export const forwardCompatWakePacket = {
  ...dmWakePacket,
  future_field: { anything: true },
} as const;
