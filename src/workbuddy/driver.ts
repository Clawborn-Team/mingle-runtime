/**
 * WorkBuddyAcpDriver (spec §5) — an AgentRuntimeDriver backed by CodeBuddy's ACP
 * server. A scope_key maps to an ACP session; one wake is one `session/prompt`,
 * whose streamed `session/update` notifications are translated (via the pure
 * mapper) into unified RuntimeEvents. The accumulated assistant text is the turn's
 * final reply — the consumer delivers it (v1 reply-text path, no mingle_* tools).
 *
 * YOLO posture: `session/request_permission` is auto-approved; the client advertises
 * no fs/terminal proxy so codebuddy executes locally in its own sandbox. If the agent
 * did not advertise `loadSession`, resume throws honestly (the consumer NACKs) rather
 * than silently starting a fresh, context-less session.
 */
import { renderWakeInput } from "../runtime/wake-render.js";
import { mapSessionUpdate, textOf, type AcpUpdate } from "./updates.js";
import type { WorkBuddyAcpClient } from "./client.js";
import type {
  AgentRuntimeDriver, ApprovalDecision, OpenSessionInput, ProviderSession,
  ProviderSessionRef, RunTurnInput, RuntimeCapabilities, RuntimeEvent, RuntimeProbe,
} from "../runtime/driver.js";

export type WorkBuddyDriverOptions = {
  client: WorkBuddyAcpClient;
  /** From initialize(): whether the agent supports session/load (resume). */
  loadSession: boolean;
  cwd?: string;
  persona?: string;
};

/** Pushed events → async-iterable pull stream (same shape the codex driver uses). */
class EventQueue {
  private readonly items: RuntimeEvent[] = [];
  private resolve?: () => void;
  private done = false;
  push(ev: RuntimeEvent): void { this.items.push(ev); this.resolve?.(); this.resolve = undefined; }
  end(): void { this.done = true; this.resolve?.(); this.resolve = undefined; }
  async *drain(): AsyncIterable<RuntimeEvent> {
    while (true) {
      while (this.items.length > 0) yield this.items.shift()!;
      if (this.done) return;
      await new Promise<void>((r) => (this.resolve = r));
    }
  }
}

export class WorkBuddyAcpDriver implements AgentRuntimeDriver {
  readonly kind = "workbuddy" as const;
  readonly capabilities: RuntimeCapabilities = {
    streaming: true, tools: true, approvals: true, fileChanges: false, resume: true,
  };

  private readonly client: WorkBuddyAcpClient;
  private readonly opts: WorkBuddyDriverOptions;

  constructor(opts: WorkBuddyDriverOptions) {
    this.client = opts.client;
    this.opts = opts;
    // Auto-approve any permission the agent asks for (YOLO): select an "allow" option.
    this.client.onServerRequest(async (method, params) => {
      if (method === "session/request_permission") {
        const p = (params ?? {}) as { options?: Array<{ optionId?: string; kind?: string }> };
        const opt = p.options?.find((o) => (o.kind ?? "").startsWith("allow")) ?? p.options?.[0];
        return { outcome: { outcome: "selected", optionId: opt?.optionId ?? "allow" } };
      }
      throw new Error(`workbuddy driver: unhandled server request ${method}`);
    });
  }

  async probe(): Promise<RuntimeProbe> {
    return { kind: this.kind, available: true };
  }

  async openSession(input: OpenSessionInput): Promise<ProviderSession> {
    const { sessionId } = await this.client.sessionNew({ cwd: input.cwd ?? this.opts.cwd });
    return { ref: { bindingId: input.bindingId, scopeKey: input.scopeKey, providerSessionId: sessionId }, createdAt: Date.now() };
  }

  async resumeSession(ref: ProviderSessionRef): Promise<ProviderSession> {
    if (!this.opts.loadSession) {
      throw new Error("workbuddy driver: agent does not support session/load (resume) — cannot restore session context");
    }
    await this.client.sessionLoad({ sessionId: ref.providerSessionId, cwd: this.opts.cwd });
    return { ref: { ...ref }, createdAt: Date.now() };
  }

  runTurn(input: RunTurnInput): AsyncIterable<RuntimeEvent> {
    const queue = new EventQueue();
    void this.driveTurn(input, queue);
    return queue.drain();
  }

  private async driveTurn(input: RunTurnInput, queue: EventQueue): Promise<void> {
    const sessionId = input.session.ref.providerSessionId;
    const turnId = `wb-turn-${sessionId}-${Date.now()}`;
    const text = renderWakeInput(input.packet, this.opts.persona);
    let assembled = "";
    const off = this.client.onNotification((method, params) => {
      if (method !== "session/update") return;
      const update = (params as { update?: AcpUpdate })?.update;
      if (!update) return;
      assembled += textOf(update);
      for (const ev of mapSessionUpdate(update, turnId)) queue.push(ev);
    });
    queue.push({ type: "turn.started", turnId });
    try {
      const { stopReason } = await this.client.sessionPrompt({ sessionId, text });
      if (stopReason === "refusal" || stopReason === "error") {
        queue.push({ type: "turn.failed", turnId, error: `stopReason: ${stopReason}` });
      } else {
        queue.push({ type: "turn.completed", turnId, text: assembled || undefined });
      }
    } catch (err) {
      queue.push({ type: "turn.failed", turnId, error: err instanceof Error ? err.message : String(err) });
    } finally {
      off();
      queue.end();
    }
  }

  async approve(_input: ApprovalDecision): Promise<void> {
    // v1 auto-approves inline in onServerRequest; no out-of-band queue.
  }

  async interrupt(_turnId: string): Promise<void> {
    // A synthetic turnId encodes the session id; cancel that session's active turn.
    const sessionId = _turnId.replace(/^wb-turn-/, "").replace(/-\d+$/, "");
    if (sessionId) this.client.sessionCancel(sessionId);
  }

  async closeSession(_ref: ProviderSessionRef): Promise<void> {
    // ACP sessions persist server-side; nothing to tear down per-scope in v1.
  }

  async shutdown(): Promise<void> {
    // Connection lifecycle is owned by the spawner (factory dispose).
  }
}
