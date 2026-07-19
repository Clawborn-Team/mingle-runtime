/**
 * Wake Packet ADAPTER (Codex review P1-2) — the raw Event Center event →
 * conversation-scope derivation, mirroring im-server's canonical builder
 * (`im-server/src/agent-protocol/wake-packet.ts`). It is exercised by the SHARED
 * cross-repo fixture set (`test/fixtures/wake-fixtures.shared.ts`) so im-server,
 * mingle-runtime, and mingle-hosted-agent never drift. If that file's
 * `WAKE_FIXTURES_VERSION` changes, the conformance test fails → re-copy verbatim.
 *
 * `deriveConversation` is the single source of scope truth for events the Runtime
 * builds itself; when a packet already carries `conversation` (built server-side),
 * `deriveScopeKey` (scope.ts) simply trusts it.
 */
import type {
  AccountNotification,
  AgentKind,
  WakeConversation,
  WakeEvent,
  WakePacket,
} from "./wake-packet.js";
import { WAKE_PACKET_SCHEMA } from "./wake-packet.js";

/**
 * Derive the conversation scope + reply target from a raw Event Center event.
 * Mirrors im-server verbatim: dm.message.created → dm; channel.mention.created /
 * channel.followup.created → channel. Unknown/absent event types → undefined
 * (forward-compatible: an unknown scope is not an error).
 */
export function deriveConversation(event: WakeEvent): WakeConversation | undefined {
  if (event.type === "dm.message.created") {
    const convo = event.payload?.conversation as { peer_id?: unknown } | undefined;
    const peerId = typeof convo?.peer_id === "string" ? convo.peer_id : undefined;
    if (peerId) {
      return {
        scope: "dm",
        scope_id: `dm:${peerId}`,
        peer_id: peerId,
        reply_target: { kind: "dm", peer_id: peerId },
      };
    }
  }
  if (event.type === "channel.mention.created" || event.type === "channel.followup.created") {
    const convo = event.payload?.conversation as { channel_id?: unknown } | undefined;
    const channelId = typeof convo?.channel_id === "string" ? convo.channel_id : undefined;
    if (channelId) {
      return {
        scope: "channel",
        scope_id: `channel:${channelId}`,
        channel_id: channelId,
        reply_target: { kind: "channel", channel_id: channelId },
      };
    }
  }
  return undefined;
}

export type BuildWakeInput =
  | { kind: "event"; event: WakeEvent }
  | { kind: "heartbeat"; event?: undefined };

/**
 * Build a complete Wake Packet from a raw event (or heartbeat). Used when the
 * Runtime constructs a packet locally; the conversation is derived canonically so
 * it is identical to what im-server would emit for the same event.
 */
export function buildWakePacket(
  agent: { account_id: string; agent_kind: AgentKind },
  wake: BuildWakeInput,
  notifications: AccountNotification[],
  traceId: string,
): WakePacket {
  const packet: WakePacket = {
    schema: WAKE_PACKET_SCHEMA,
    agent,
    wake: { kind: wake.kind, event: wake.event },
    notifications,
    trace_id: traceId,
  };
  if (wake.kind === "event" && wake.event) {
    const conversation = deriveConversation(wake.event);
    if (conversation) packet.conversation = conversation;
  }
  return packet;
}
