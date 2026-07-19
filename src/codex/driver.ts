/**
 * CodexAppServerDriver (spec §5.4) — an `AgentRuntimeDriver` backed by the Codex
 * App Server. A scope_key maps to a Codex thread; a turn is `turn/start` and its
 * streamed item + turn notifications are translated into the unified
 * `RuntimeEvent`s. Approvals arrive as server-initiated JSON-RPC requests
 * (item .../requestApproval); the driver surfaces them as `approval.requested`
 * and holds the JSON-RPC response open until `approve()` decides, so the runtime
 * (or owner) makes the call rather than the model self-approving.
 *
 * `codex exec` is NOT used here — it stays a diagnostics-only fallback (§5.4).
 */
import { CodexAppServerClient, type ApprovalPolicy, type SandboxPolicy } from "./client.js";
import { renderWakeInput } from "../runtime/wake-render.js";
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

export type CodexDriverOptions = {
  client: CodexAppServerClient;
  /** Per-turn defaults; a real install resolves these from the binding profile. */
  approvalPolicy?: ApprovalPolicy;
  sandboxPolicy?: SandboxPolicy;
  model?: string;
};

/** A queue that turns pushed events into an async-iterable pull stream. */
class EventQueue {
  private readonly items: RuntimeEvent[] = [];
  private resolve?: () => void;
  private done = false;

  push(ev: RuntimeEvent): void {
    this.items.push(ev);
    this.resolve?.();
    this.resolve = undefined;
  }

  end(): void {
    this.done = true;
    this.resolve?.();
    this.resolve = undefined;
  }

  async *drain(): AsyncIterable<RuntimeEvent> {
    while (true) {
      while (this.items.length > 0) yield this.items.shift()!;
      if (this.done) return;
      await new Promise<void>((r) => (this.resolve = r));
    }
  }
}

export class CodexAppServerDriver implements AgentRuntimeDriver {
  readonly kind = "codex" as const;
  readonly capabilities: RuntimeCapabilities = {
    streaming: true,
    tools: true,
    approvals: true,
    fileChanges: true,
    resume: true,
  };

  private readonly codex: CodexAppServerClient;
  private readonly opts: CodexDriverOptions;
  /** approvalId → resolver of the pending server-request (set when surfaced). */
  private readonly pendingApprovals = new Map<string, (decision: string) => void>();

  constructor(opts: CodexDriverOptions) {
    this.codex = opts.client;
    this.opts = opts;
    // Answer Codex's server-initiated approval requests. We resolve the JSON-RPC
    // response only once approve()/decline is called for that approvalId.
    this.codex.onServerRequest(async (method, params) => {
      if (method.endsWith("/requestApproval")) {
        const p = (params ?? {}) as Record<string, any>;
        const approvalId: string = p.itemId ?? p.id ?? "unknown";
        return await new Promise<string>((resolve) => {
          this.pendingApprovals.set(approvalId, resolve);
          this.currentQueue?.push({
            type: "approval.requested",
            turnId: this.currentTurnId ?? p.turnId ?? "",
            approvalId,
            detail: p.command ? `run: ${p.command}` : method,
          });
        });
      }
      throw new Error(`codex driver: unhandled server request ${method}`);
    });
  }

  private currentQueue?: EventQueue;
  private currentTurnId?: string;

  async probe(): Promise<RuntimeProbe> {
    return { kind: this.kind, available: true };
  }

  async openSession(input: OpenSessionInput): Promise<ProviderSession> {
    const thread = await this.codex.threadStart({
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(this.opts.approvalPolicy ? { approvalPolicy: this.opts.approvalPolicy } : {}),
      ...(this.opts.sandboxPolicy ? { sandbox: this.opts.sandboxPolicy } : {}),
      ...(this.opts.model ? { model: this.opts.model } : {}),
    });
    return {
      ref: { bindingId: input.bindingId, scopeKey: input.scopeKey, providerSessionId: thread.threadId },
      createdAt: Date.now(),
    };
  }

  async resumeSession(ref: ProviderSessionRef): Promise<ProviderSession> {
    const thread = await this.codex.threadResume(ref.providerSessionId);
    return {
      ref: { ...ref, providerSessionId: thread.threadId },
      createdAt: Date.now(),
    };
  }

  runTurn(input: RunTurnInput): AsyncIterable<RuntimeEvent> {
    const queue = new EventQueue();
    this.currentQueue = queue;
    void this.driveTurn(input, queue);
    return queue.drain();
  }

  private async driveTurn(input: RunTurnInput, queue: EventQueue): Promise<void> {
    const text = renderWakeInput(input.packet);
    this.currentThreadId = input.session.ref.providerSessionId;
    this.assembledText = "";
    this.finalText = "";
    const off = this.codex.onNotification((method, params) => {
      const p = (params ?? {}) as Record<string, any>;
      switch (method) {
        case "turn/started":
          this.currentTurnId = p.turn?.id;
          queue.push({ type: "turn.started", turnId: p.turn?.id ?? "" });
          break;
        case "item/agentMessage/delta": {
          const chunk = p.delta ?? p.text ?? "";
          this.assembledText += chunk;
          queue.push({ type: "assistant.delta", turnId: this.currentTurnId ?? "", text: chunk });
          break;
        }
        case "item/started":
          if (p.item?.type === "commandExecution" || p.item?.type === "mcpToolCall") {
            queue.push({ type: "tool.started", turnId: this.currentTurnId ?? "", toolId: p.item.id, name: p.item.type });
          }
          break;
        case "item/completed":
          if (p.item?.type === "agentMessage" && typeof p.item?.text === "string" && p.item.text.trim()) {
            // The AUTHORITATIVE final answer. Streaming deltas are a nicety and can
            // be missed/absent (the model may produce the answer without streaming);
            // item/completed always carries the full text. Take the last one.
            this.finalText = p.item.text;
          } else if (p.item?.type === "commandExecution" || p.item?.type === "mcpToolCall") {
            queue.push({ type: "tool.completed", turnId: this.currentTurnId ?? "", toolId: p.item.id, ok: p.item.approved !== false });
          }
          break;
        default:
          break;
      }
    });

    try {
      const turn = await this.codex.turnStart({
        threadId: input.session.ref.providerSessionId,
        text,
        ...(this.opts.approvalPolicy ? { approvalPolicy: this.opts.approvalPolicy } : {}),
        ...(this.opts.sandboxPolicy ? { sandboxPolicy: this.opts.sandboxPolicy } : {}),
        ...(this.opts.model ? { model: this.opts.model } : {}),
      });
      this.currentTurnId = turn.turnId;
      const result = await turn.completed;
      if (result.status === "completed") {
        // Prefer the authoritative item/completed text; fall back to streamed deltas.
        queue.push({ type: "turn.completed", turnId: turn.turnId, text: this.finalText || this.assembledText || undefined });
      } else {
        queue.push({ type: "turn.failed", turnId: turn.turnId, error: result.error ?? result.status });
      }
    } catch (err) {
      queue.push({ type: "turn.failed", turnId: this.currentTurnId ?? "", error: err instanceof Error ? err.message : String(err) });
    } finally {
      off();
      queue.end();
      this.currentQueue = undefined;
    }
  }

  /** Streamed assistant text (deltas) + the authoritative final answer text from
   *  item/completed. turn.completed prefers finalText, falling back to deltas. */
  private assembledText = "";
  private finalText = "";

  async approve(input: ApprovalDecision): Promise<void> {
    const resolve = this.pendingApprovals.get(input.approvalId);
    if (resolve) {
      this.pendingApprovals.delete(input.approvalId);
      resolve(input.approved ? "accept" : "decline");
    }
  }

  async interrupt(turnId: string): Promise<void> {
    // The active thread is the one running the current turn.
    if (this.currentThreadId) await this.codex.turnInterrupt(this.currentThreadId, turnId);
  }
  private currentThreadId?: string;

  async closeSession(_ref: ProviderSessionRef): Promise<void> {
    // App Server threads persist; nothing to tear down per-scope in V1.
  }

  async shutdown(): Promise<void> {
    // Connection lifecycle is owned by the spawner (A2 real-binary path).
  }
}
