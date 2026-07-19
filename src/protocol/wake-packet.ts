/**
 * Wake Packet — the inbound half of the Mingle Agent Protocol (spec §4.1),
 * schema `"mingle.agent-wake.v1"`. The runtime CONSUMES this from the Event
 * Center; it is the SAME schema every consumer (OpenClaw / Claude / Codex /
 * Hosted) parses, so this mirrors `im-server/src/agent-protocol/wake-packet.ts`.
 *
 * Parsing is deliberately tolerant (§13.1 forward-compat): unknown top-level
 * fields are ignored, and the structured `event` / `notifications` / reply
 * target are passed through as-is — never restringified into fuzzy text.
 */

export const WAKE_PACKET_SCHEMA = "mingle.agent-wake.v1" as const;

export type AgentKind = "local" | "companion" | "service";

/** A background notification carried alongside the wake (structured, not a command). */
export type AccountNotification = { id: string; type: string; payload?: Record<string, unknown> };

/** A raw Event Center event, in its API shape (type + payload). */
export type WakeEvent = { id: string; type: string; payload?: Record<string, unknown> };

export type ReplyTarget =
  | { kind: "dm"; peer_id: string }
  | { kind: "channel"; channel_id: string }
  | { kind: "owner"; owner_id: string }
  | { kind: "task"; task_id: string };

export type ConversationScope = "dm" | "channel" | "owner" | "task";

export type WakeConversation = {
  scope: ConversationScope;
  scope_id: string;
  peer_id?: string;
  channel_id?: string;
  reply_target: ReplyTarget;
};

export type WakePacket = {
  schema: typeof WAKE_PACKET_SCHEMA;
  agent: { account_id: string; agent_kind: AgentKind };
  wake: { kind: "event" | "heartbeat"; event?: WakeEvent };
  notifications: AccountNotification[];
  conversation?: WakeConversation;
  trace_id: string;
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Parse + validate a raw packet into a typed `WakePacket`. Throws on the schema
 * mismatch or missing required shape; tolerates unknown extra fields. Structured
 * sub-objects (event, notifications, conversation) are passed through unchanged.
 */
export function parseWakePacket(raw: unknown): WakePacket {
  if (!isObject(raw)) throw new Error("wake packet: not an object");
  if (raw.schema !== WAKE_PACKET_SCHEMA) {
    throw new Error(`wake packet: unexpected schema ${JSON.stringify(raw.schema)}`);
  }
  const agent = raw.agent;
  if (!isObject(agent) || typeof agent.account_id !== "string" || typeof agent.agent_kind !== "string") {
    throw new Error("wake packet: missing or invalid agent");
  }
  const wake = raw.wake;
  if (!isObject(wake) || (wake.kind !== "event" && wake.kind !== "heartbeat")) {
    throw new Error("wake packet: missing or invalid wake");
  }
  if (typeof raw.trace_id !== "string") throw new Error("wake packet: missing trace_id");

  const notifications = Array.isArray(raw.notifications)
    ? (raw.notifications as AccountNotification[])
    : [];

  const packet: WakePacket = {
    schema: WAKE_PACKET_SCHEMA,
    agent: { account_id: agent.account_id, agent_kind: agent.agent_kind as AgentKind },
    wake: { kind: wake.kind, event: isObject(wake.event) ? (wake.event as WakeEvent) : undefined },
    notifications,
    trace_id: raw.trace_id,
  };

  if (isObject(raw.conversation)) {
    packet.conversation = raw.conversation as unknown as WakeConversation;
  }

  return packet;
}
