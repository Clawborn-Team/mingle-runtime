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
import { parseWakePacket, type WakePacket } from "../protocol/wake-packet.js";
import { deriveScopeKey } from "../protocol/scope.js";
import type { AgentRuntimeDriver, ProviderSession, RuntimeEvent } from "./driver.js";
import type { RuntimeKind, SessionRegistry } from "./session-registry.js";

/** One agent binding the runtime drives. */
export type Binding = {
  bindingId: string;
  agentAccountId: string;
  ownerAccountId: string;
  runtimeKind: RuntimeKind;
};

/** A single Event Center update: the durable event id + its Wake Packet payload. */
export type EventUpdate = { id: string; packet: unknown };
export type UpdatesResult = { events: EventUpdate[]; next_cursor?: string };

/** The minimal Event Center surface the loop needs (learned from the reference
 *  connector's ImClient, re-implemented here — nothing imported from openclaw-mingle). */
export interface EventCenterClient {
  getUpdates(opts: { cursor?: string; wait?: number }): Promise<UpdatesResult>;
  ack(eventIds: string[]): Promise<void>;
  sendDm(to: string, body: string): Promise<{ ok: boolean; status: number }>;
}

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

  const events: RuntimeEvent[] = [];
  let reply: string | undefined;
  for await (const ev of driver.runTurn({ session, packet })) {
    events.push(ev);
    if (ev.type === "turn.completed" && ev.text) reply = ev.text;
  }

  await registry.touch(binding.bindingId, scopeKey, {
    lastTurnAt: Date.now(),
    health: events.some((e) => e.type === "turn.failed") ? "error" : "ok",
  });

  if (reply) await deliverReply(packet, reply, imClient);

  return { scopeKey, session, events, reply };
}

/** Deliver a turn's reply to the wake's reply target. A1 handles the dm target
 *  (channel/owner/task posting is a later Action). */
async function deliverReply(packet: WakePacket, reply: string, imClient: EventCenterClient): Promise<void> {
  const target = packet.conversation?.reply_target;
  if (target?.kind === "dm") await imClient.sendDm(target.peer_id, reply);
}

/** Drain exactly one update batch: handle each wake, ACK every event, return the
 *  next cursor. A malformed / non-Mingle packet is skipped but still ACKed (safe
 *  to drop), mirroring the reference loop. */
export async function runBindingOnce(input: {
  binding: Binding;
  driver: AgentRuntimeDriver;
  registry: SessionRegistry;
  imClient: EventCenterClient;
  cursor?: string;
  wait?: number;
}): Promise<string | undefined> {
  const { binding, driver, registry, imClient } = input;
  const { events, next_cursor } = await imClient.getUpdates({
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.wait !== undefined ? { wait: input.wait } : {}),
  });

  const ackIds: string[] = [];
  for (const update of events) {
    try {
      const packet = parseWakePacket(update.packet);
      await processWake({ packet, binding, driver, registry, imClient });
    } catch {
      // Not a valid Mingle wake / non-actionable — safe to drop, still ACK.
    }
    ackIds.push(update.id);
  }
  if (ackIds.length > 0) await imClient.ack(ackIds);

  return next_cursor ?? input.cursor;
}
