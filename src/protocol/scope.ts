/**
 * Session scope keys (spec §4.3). One Agent identity fans out into many sessions
 * keyed by conversation/task:
 *
 *   dm:<peerAccountId> · channel:<channelId> · owner:<ownerAccountId> · task:<taskId>
 *
 * Same scope_key → same provider session/thread on the next wake; different DMs /
 * channels / tasks are isolated by default. A heartbeat (no conversation) maps to
 * the binding's owner scope. The mapping is the Runtime's — it is never persisted
 * into im-server's message tables.
 */
import type { WakePacket, WakeConversation } from "./wake-packet.js";

export type ScopeContext = { ownerAccountId: string };

export function deriveScopeKey(packet: WakePacket, ctx: ScopeContext): string {
  const convo = packet.conversation;
  if (!convo) return `owner:${ctx.ownerAccountId}`;
  // Trust a well-formed scope_id, else compose one from scope + the id fields.
  if (convo.scope_id) return convo.scope_id;
  return composeScopeId(convo, ctx);
}

function composeScopeId(convo: WakeConversation, ctx: ScopeContext): string {
  switch (convo.scope) {
    case "dm":
      return `dm:${convo.peer_id ?? idFromReplyTarget(convo)}`;
    case "channel":
      return `channel:${convo.channel_id ?? idFromReplyTarget(convo)}`;
    case "task":
      return `task:${idFromReplyTarget(convo)}`;
    case "owner":
      return `owner:${ctx.ownerAccountId}`;
    default:
      return `owner:${ctx.ownerAccountId}`;
  }
}

function idFromReplyTarget(convo: WakeConversation): string {
  const rt = convo.reply_target;
  switch (rt.kind) {
    case "dm":
      return rt.peer_id;
    case "channel":
      return rt.channel_id;
    case "owner":
      return rt.owner_id;
    case "task":
      return rt.task_id;
  }
}
