/**
 * Consumer loop (spec §5.1). For one binding it long-polls the Event Center,
 * turns each Wake Packet into a scope_key, opens-or-resumes the provider session
 * for that scope, drives ONE turn through the driver, delivers the reply to the
 * packet's reply target, and ACKs. Same scope → same session (resume); different
 * scopes are isolated. The im-client + driver are injected so this runs against a
 * Fake with no network (A1) and a real provider later.
 *
 * At-least-once, matching the reference connector: ACK after handling; a crash
 * resumes from the last cursor. NACK/backoff semantics are refined in A2 with a
 * real provider whose turns can fail mid-flight.
 */
import type { WakePacket } from "../protocol/wake-packet.js";
import { buildWakePacket, deriveConversation } from "../protocol/wake-adapter.js";
import { deriveScopeKey } from "../protocol/scope.js";
import type { RuntimeUpdateDirective } from "./self-update.js";
import type { AgentRuntimeDriver, ProviderSession, QuestionBlock, RuntimeEvent } from "./driver.js";
import type { RuntimeKind, SessionRegistry } from "./session-registry.js";
import { materializeWakeMedia } from "./media-materializer.js";
import { summarizeEvent } from "./activity-summary.js";
import { ownerContextTask } from "./wake-render.js";
import { isValidOwnerContextReport } from "../owner-context/validate.js";

/** Where a live-status update is directed: a DM peer, or a channel (broadcast to members). */
export type ActivityTarget = { peerId: string } | { channelId: string };

/** Optional structured content (mingle.message.v1) carried on a sent message. */
export type StructuredContent = { contentType: "structured"; payload: Record<string, unknown> };

/** One agent binding the runtime drives. */
export type Binding = {
  bindingId: string;
  agentAccountId: string;
  ownerAccountId: string;
  runtimeKind: RuntimeKind;
};

/** A raw Event Center event as returned by `GET /v1/event-center/updates`
 *  (`{id, type, payload}`). The runtime builds the Wake Packet from it locally via
 *  the wake-adapter — im-server does NOT pre-build the packet (matches how
 *  mingle-hosted-agent consumes the same stream). */
export type RawAccountEvent = { id: string; type: string; payload?: Record<string, unknown> };
export type UpdatesResult = {
  events: RawAccountEvent[];
  notifications?: RawAccountEvent[];
  next_cursor?: string;
  /** Platform-controlled directives (e.g. runtime.update) — surfaced to the daemon. */
  runtime_directives?: RuntimeUpdateDirective[];
};

/** The minimal Event Center surface the loop needs (learned from the reference
 *  connector's ImClient, re-implemented here — nothing imported from openclaw-mingle). */
export interface EventCenterClient {
  getUpdates(opts: { cursor?: string; wait?: number; digest?: boolean }): Promise<UpdatesResult>;
  ack(eventIds: string[]): Promise<void>;
  /** Negative-ack a single event so the Event Center backs it off + eventually
   *  dead-letters it (mirrors im-server's per-event delivery discipline). */
  nack(eventId: string, reason: string): Promise<void>;
  sendDm(to: string, body: string, structured?: StructuredContent): Promise<{ ok: boolean; status: number }>;
  downloadMedia?(mediaId: string): Promise<{ bytes: Buffer; contentType: string }>;
  /** Post a reply back to a channel (group/plaza @ + follow-up, P1-3). */
  postToChannel(channelId: string, body: string, structured?: StructuredContent): Promise<{ ok: boolean; status: number }>;
  /** Report a turn's ephemeral live status toward a DM peer or a channel (rolling
   *  one-line summary). Optional (best-effort presence) so test fakes needn't implement
   *  it; `working` sets/refreshes the line, `done`/`failed` clear it. */
  postActivity?(target: ActivityTarget, state: "working" | "done" | "failed", detail?: string): Promise<void>;
  /** Best-effort product status for the owner's Local Agent page. Contains no
   * session text, only refresh state metadata. */
  reportOwnerContext?(status: { status: "prepared" | "success" | "failure"; updated_at: number; mode: "recent-briefing" | "owner-portrait"; material_change?: boolean; error?: string }): Promise<void>;
  /** Commit the just-delivered owner-context refresh's window fingerprint. Called by
   *  processWake ONLY after an owner-context report actually reached the Companion, so
   *  a computed-but-undelivered refresh never consumes the window (no-change-gate fix). */
  commitOwnerContext?(): Promise<void>;
}

/** Whether a turn's reply reached its target. `unsupported` means the reply
 *  target kind has no delivery route yet — the caller must NACK, not ACK. */
export type ReplyDelivery = "delivered" | "none" | "unsupported";

export type ProcessWakeInput = {
  packet: WakePacket;
  binding: Binding;
  driver: AgentRuntimeDriver;
  registry: SessionRegistry;
  imClient: EventCenterClient;
};

export type ProcessWakeResult = {
  scopeKey: string;
  session: ProviderSession;
  events: RuntimeEvent[];
  reply?: string;
  /** How the reply was delivered — `unsupported` means the target has no route. */
  delivery: ReplyDelivery;
};

/** Open-or-resume the session for this (binding, scope), then run one turn. */
export async function processWake(input: ProcessWakeInput): Promise<ProcessWakeResult> {
  const { packet, binding, driver, registry, imClient } = input;
  const scopeKey = deriveScopeKey(packet, { ownerAccountId: binding.ownerAccountId });

  const existing = await registry.get(binding.bindingId, scopeKey);
  let session: ProviderSession;
  if (existing) {
    session = await driver.resumeSession({
      bindingId: binding.bindingId,
      scopeKey,
      providerSessionId: existing.providerSessionId,
    });
  } else {
    session = await driver.openSession({ bindingId: binding.bindingId, scopeKey });
    await registry.put({
      bindingId: binding.bindingId,
      agentAccountId: binding.agentAccountId,
      runtimeKind: binding.runtimeKind,
      scopeKey,
      providerSessionId: session.ref.providerSessionId,
    });
  }

  // Truthful live status: a rolling one-line summary of the latest intermediate product,
  // pushed as the turn runs and cleared on completion. A DM notifies its single peer; a
  // channel broadcasts to its members. Best-effort, never blocks the turn (spec §4).
  const rt = packet.conversation?.reply_target;
  const activityTarget: ActivityTarget | undefined =
    rt?.kind === "dm" ? { peerId: rt.peer_id } : rt?.kind === "channel" ? { channelId: rt.channel_id } : undefined;
  const pushActivity = (state: "working" | "done" | "failed", detail?: string) => {
    if (activityTarget) void imClient.postActivity?.(activityTarget, state, detail).catch(() => {});
  };

  const events: RuntimeEvent[] = [];
  let reply: string | undefined;
  let assistantText = "";
  const materialized = await materializeWakeMedia(packet, {
    imageInputs: driver.capabilities.imageInputs,
    downloadMedia: imClient.downloadMedia?.bind(imClient),
  });
  try {
    for await (const ev of driver.runTurn({ session, packet: materialized.packet })) {
      events.push(ev);
      if (ev.type === "assistant.delta") assistantText += ev.text;
      if (ev.type === "turn.completed" && ev.text) reply = ev.text;
      const line = summarizeEvent(ev, { assistantText });
      if (line) pushActivity("working", line);
    }
  } finally {
    pushActivity(events.some((e) => e.type === "turn.failed") ? "failed" : "done");
    await materialized.cleanup();
  }

  await registry.touch(binding.bindingId, scopeKey, {
    lastTurnAt: Date.now(),
    health: events.some((e) => e.type === "turn.failed") ? "error" : "ok",
  });

  // A turn that raised native questions delivers ONE structured message (the question
  // blocks) instead of a plaintext reply; the answer arrives as a later wake that
  // resumes THIS scope's session naturally (spec §5, approach #1).
  const questionBlocks = events.flatMap((e) => (e.type === "question.raised" ? [e.block] : []));
  let outBody = reply;
  let structured: StructuredContent | undefined;
  if (questionBlocks.length > 0) {
    const msg = buildQuestionMessage(questionBlocks, binding.runtimeKind);
    outBody = msg.body;
    structured = msg.structured;
  }

  const delivery = outBody ? await deliverReply(packet, outBody, imClient, structured) : "none";

  // An owner-context refresh consumes its window ONLY once a VALID distilled report
  // has actually been delivered to the Companion. Two guards, both required:
  //   1) the turn did not fail (no turn.failed event), AND
  //   2) the delivered body validates against owner-context-v1 FOR THE REQUESTED MODE.
  // A provider apology / truncated JSON / wrong-mode reply that still gets DM-delivered
  // must NOT consume the window — otherwise the next identical refresh returns a canned
  // no-change report (re-opening the stale-empty bug). We still ACK the delivered case
  // (the caller does not NACK here), so the delivered-but-invalid path does not
  // double-send; recovery is the next externally-triggered refresh re-distilling the
  // still-open window (its next prepare returns material_change=true).
  const ownerTask = ownerContextTask(packet);
  if (
    delivery === "delivered" &&
    ownerTask !== null &&
    !events.some((e) => e.type === "turn.failed") &&
    isValidOwnerContextReport(outBody, ownerTask.mode)
  ) {
    await imClient.commitOwnerContext?.();
  }

  return { scopeKey, session, events, reply: outBody, delivery };
}

/** Assemble a mingle.message.v1 structured message carrying the turn's question block(s).
 *  body stays a short non-empty plaintext fallback (spec §5.1). */
function buildQuestionMessage(
  blocks: QuestionBlock[],
  runtimeKind: RuntimeKind,
): { body: string; structured: StructuredContent } {
  const body = blocks.length === 1 ? blocks[0]!.prompt : "我想先确认几个问题";
  const provider = runtimeKind === "claude-code" || runtimeKind === "codex" ? runtimeKind : null;
  return {
    body,
    structured: { contentType: "structured", payload: { schema: "mingle.message.v1", provider, blocks } },
  };
}

/**
 * Deliver a turn's reply to the wake's reply target. DM → sendDm; channel (group
 * / plaza @ + follow-up, P1-3) → postToChannel. A target kind we can't route yet
 * returns `unsupported` so the caller NACKs instead of silently dropping the
 * reply (owner/task Actions land in a later increment).
 *
 * im-server posts to a channel by SLUG (`/v1/channels/:slug/messages`), but the
 * reply_target only carries `channel_id`. The raw wake event carries the slug
 * (`payload.conversation.channel_slug`), so we route by that; a channel wake
 * without a recoverable slug is `unsupported` (NACK) rather than a wrong post.
 */
async function deliverReply(
  packet: WakePacket,
  reply: string,
  imClient: EventCenterClient,
  structured?: StructuredContent,
): Promise<ReplyDelivery> {
  const target = packet.conversation?.reply_target;
  if (!target) return "unsupported";
  switch (target.kind) {
    case "dm": {
      const r = await imClient.sendDm(target.peer_id, reply, structured);
      // A failed send (403/500/…) must NOT be treated as delivered — throw so the
      // caller NACKs (backoff + redelivery) instead of ACKing a lost reply (P0-b).
      if (!r.ok) throw new Error(`dm delivery failed (status ${r.status})`);
      return "delivered";
    }
    case "channel": {
      const slug = channelSlugFromEvent(packet);
      if (!slug) return "unsupported";
      const r = await imClient.postToChannel(slug, reply, structured);
      if (!r.ok) throw new Error(`channel delivery failed (status ${r.status})`);
      return "delivered";
    }
    default:
      // owner/task have no delivery route yet — do NOT pretend it was handled.
      return "unsupported";
  }
}

/** The channel slug carried on the raw wake event (im-server posts by slug). */
function channelSlugFromEvent(packet: WakePacket): string | undefined {
  const convo = packet.wake.event?.payload?.conversation as { channel_slug?: unknown } | undefined;
  return typeof convo?.channel_slug === "string" && convo.channel_slug ? convo.channel_slug : undefined;
}

/**
 * Drain exactly one update batch with the same per-event delivery discipline as
 * im-server's companion runtime (the P0-3 fix — ACK-on-failure loses wakes):
 *
 *  - non-actionable / unparseable packet → drop + ACK (safe).
 *  - successful turn                      → ACK.
 *  - TRANSIENTLY-failed turn (turn.failed, or a thrown provider/network error)
 *    → NACK (Event Center backs it off + eventually dead-letters), then STOP
 *    draining so we don't ACK past the gap; the rest stay pending for redelivery.
 *
 * ACKs earned before the gap are flushed. Returns the next cursor (advanced only
 * to the point we cleanly handled).
 */
export async function runBindingOnce(input: {
  binding: Binding;
  driver: AgentRuntimeDriver;
  registry: SessionRegistry;
  imClient: EventCenterClient;
  cursor?: string;
  wait?: number;
  /** Platform directives (runtime.update, …) surfaced to the daemon for self-update. */
  onDirectives?: (directives: RuntimeUpdateDirective[]) => void;
}): Promise<string | undefined> {
  const { binding, driver, registry, imClient } = input;
  const { events, next_cursor, runtime_directives } = await imClient.getUpdates({
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.wait !== undefined ? { wait: input.wait } : {}),
  });
  if (runtime_directives && runtime_directives.length > 0) input.onDirectives?.(runtime_directives);

  const ackIds: string[] = [];
  let gapped = false;
  for (const raw of events) {
    // Build the Wake Packet from the raw event locally (im-server returns raw
    // `{id,type,payload}`, never a pre-built packet). An event that derives no
    // conversation (heartbeat/notification-only or an unknown future type) is not
    // an actionable turn for this binding → drop + ACK (forward-compatible).
    const conversation = deriveConversation({ id: raw.id, type: raw.type, payload: raw.payload });
    if (!conversation) {
      ackIds.push(raw.id);
      continue;
    }
    const packet: WakePacket = buildWakePacket(
      { account_id: binding.agentAccountId, agent_kind: "local" },
      { kind: "event", event: { id: raw.id, type: raw.type, payload: raw.payload } },
      [],
      raw.id,
    );

    try {
      const result = await processWake({ packet, binding, driver, registry, imClient });
      if (result.events.some((e) => e.type === "turn.failed")) {
        // Transient turn failure → NACK for backoff, stop draining (P0-3).
        const reason = failureReason(result.events);
        await imClient.nack(raw.id, reason);
        gapped = true;
        break;
      }
      if (result.delivery === "unsupported") {
        // The turn produced a reply we couldn't route (e.g. a channel wake with no
        // recoverable slug). NACK rather than silently ACK — the reply must not vanish (P1-3).
        await imClient.nack(raw.id, `unsupported reply target (${result.scopeKey})`);
        gapped = true;
        break;
      }
      ackIds.push(raw.id); // handled + delivered successfully → ACK
    } catch (err) {
      // A thrown error (provider crash / network / failed delivery) is transient → NACK + stop.
      await imClient.nack(raw.id, err instanceof Error ? err.message : String(err));
      gapped = true;
      break;
    }
  }

  if (ackIds.length > 0) await imClient.ack(ackIds);

  // Advance the cursor only when the whole batch drained cleanly; a gap leaves it
  // so the NACKed + trailing events redeliver.
  return gapped ? input.cursor : next_cursor ?? input.cursor;
}

function failureReason(events: RuntimeEvent[]): string {
  const failed = events.find((e) => e.type === "turn.failed");
  return failed && "error" in failed ? failed.error : "turn failed";
}

/**
 * Digest heartbeat (spec §4 / mirrors the Hosted service's digest). Poll the Event
 * Center with `digest=true` (no wait): the server returns pending NOTIFICATIONS even
 * when there is no immediate wake event. If any exist, drive ONE heartbeat turn that
 * carries them as background context, so notification-only activity (a channel
 * follow-up, an ambient opportunity) still periodically wakes the Local Agent. It
 * consumes/acks NOTHING — event draining + cursor stay with the drain loop — so it is
 * safe to run on the same consumer. Returns whether a heartbeat turn was driven.
 */
export async function runDigestOnce(input: {
  binding: Binding;
  driver: AgentRuntimeDriver;
  registry: SessionRegistry;
  imClient: EventCenterClient;
}): Promise<boolean> {
  const { binding, driver, registry, imClient } = input;
  const { notifications } = await imClient.getUpdates({ wait: 0, digest: true });
  if (!notifications || notifications.length === 0) return false;

  const packet = buildWakePacket(
    { account_id: binding.agentAccountId, agent_kind: "local" },
    { kind: "heartbeat" },
    notifications.map((n) => ({ id: n.id, type: n.type, payload: n.payload })),
    `digest-${Date.now()}`,
  );
  // A heartbeat has no reply target; the turn may act via tools but delivery is
  // "none"/"unsupported" — we neither ack nor nack (the drain loop owns events).
  await processWake({ packet, binding, driver, registry, imClient });
  return true;
}
