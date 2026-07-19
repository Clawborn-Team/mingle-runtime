/**
 * OpenClawDriver (spec §5.6) — adapts the OpenClaw Gateway lifecycle to the
 * unified `AgentRuntimeDriver`. It is an ADAPTER, not a CLI wrapper: no
 * `openclaw` subprocess, no stdout scraping. A Mingle scope_key maps to a Gateway
 * session; one wake runs one Gateway turn; the Gateway's reply is mapped to the
 * unified `RuntimeEvent`s. Crucially it feeds the Gateway the SAME structured
 * `renderWakeInput()` every other driver uses (Codex/Claude), so group @, DM, and
 * heartbeat+notifications reach the agent with full context (P1-5), not a bare body.
 *
 * OpenClaw's own tools/channel routing stay inside the Gateway; capabilities are
 * declared honestly so the runtime degrades the UI where OpenClaw doesn't stream.
 */
import type {
  AgentRuntimeDriver,
  ApprovalDecision,
  OpenSessionInput,
  ProviderSession,
  ProviderSessionRef,
  RunTurnInput,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeProbe,
} from "../runtime/driver.js";
import { renderWakeInput } from "../runtime/wake-render.js";
import type { OpenClawGateway } from "./gateway.js";

export type OpenClawDriverOptions = {
  gateway: OpenClawGateway;
  /** Local Agent persona prepended to each turn (so the Gateway agent answers as this agent). */
  persona?: string;
};

export class OpenClawDriver implements AgentRuntimeDriver {
  readonly kind = "openclaw" as const;
  readonly capabilities: RuntimeCapabilities = {
    // The Gateway runs the turn and returns a reply; it does not stream token
    // deltas back through this seam, so the runtime degrades the live-typing UI.
    streaming: false,
    tools: true,
    approvals: false,
    fileChanges: false,
    resume: true,
  };

  private readonly gateway: OpenClawGateway;
  private readonly persona?: string;

  constructor(opts: OpenClawDriverOptions) {
    this.gateway = opts.gateway;
    this.persona = opts.persona;
  }

  async probe(): Promise<RuntimeProbe> {
    return { kind: this.kind, available: true };
  }

  async openSession(input: OpenSessionInput): Promise<ProviderSession> {
    const { sessionKey } = await this.gateway.openSession({
      bindingId: input.bindingId,
      scopeKey: input.scopeKey,
    });
    return {
      ref: { bindingId: input.bindingId, scopeKey: input.scopeKey, providerSessionId: sessionKey },
      createdAt: Date.now(),
    };
  }

  async resumeSession(ref: ProviderSessionRef): Promise<ProviderSession> {
    const { sessionKey } = await this.gateway.resumeSession(ref.providerSessionId);
    return { ref: { ...ref, providerSessionId: sessionKey }, createdAt: Date.now() };
  }

  async *runTurn(input: RunTurnInput): AsyncIterable<RuntimeEvent> {
    const turnId = `oc-turn-${input.session.ref.providerSessionId}-${Date.now()}`;
    yield { type: "turn.started", turnId };
    try {
      const result = await this.gateway.runTurn({
        sessionKey: input.session.ref.providerSessionId,
        input: renderWakeInput(input.packet, this.persona),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      for (const t of result.tools ?? []) {
        yield { type: "tool.started", turnId, toolId: t.id, name: t.name };
        yield { type: "tool.completed", turnId, toolId: t.id, ok: t.ok };
      }
      if (result.reply) yield { type: "assistant.delta", turnId, text: result.reply };
      yield { type: "turn.completed", turnId, text: result.reply };
    } catch (err) {
      yield { type: "turn.failed", turnId, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async approve(_input: ApprovalDecision): Promise<void> {
    // OpenClaw's own approval flow lives in the Gateway; no Mingle-side queue in V1.
  }

  async interrupt(turnId: string): Promise<void> {
    // turnId encodes the session key prefix; interrupt via the Gateway.
    const sessionKey = turnId.replace(/^oc-turn-/, "").replace(/-\d+$/, "");
    await this.gateway.interrupt(sessionKey);
  }

  async closeSession(ref: ProviderSessionRef): Promise<void> {
    await this.gateway.closeSession(ref.providerSessionId);
  }

  async shutdown(): Promise<void> {
    // The Gateway lifecycle is owned by OpenClaw; nothing to tear down here.
  }
}
