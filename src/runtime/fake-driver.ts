/**
 * FakeDriver — an in-memory `AgentRuntimeDriver` test double. It proves the
 * consumer loop + session registry end-to-end without any real provider (A1),
 * and gives later increments a scriptable stand-in for edge cases (approval,
 * failure). It streams the canonical `RuntimeEvent` sequence and records
 * approvals/interrupts for assertion.
 */
import { randomUUID } from "node:crypto";
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
} from "./driver.js";

type Script = "reply" | "approval-then-fail";

export type FakeDriverOptions = {
  reply?: string;
  script?: Script;
};

export class FakeDriver implements AgentRuntimeDriver {
  readonly kind = "codex" as const;
  readonly capabilities: RuntimeCapabilities = {
    streaming: true,
    tools: true,
    approvals: true,
    fileChanges: false,
    resume: true,
  };

  /** Observable side effects for tests. */
  readonly approvals: { turnId: string; approvalId: string; approved: boolean }[] = [];
  readonly interrupts: string[] = [];
  readonly openedScopes: string[] = [];
  closed = false;

  private readonly reply: string;
  private readonly script: Script;

  constructor(opts: FakeDriverOptions = {}) {
    this.reply = opts.reply ?? "ok";
    this.script = opts.script ?? "reply";
  }

  async probe(): Promise<RuntimeProbe> {
    return { kind: this.kind, available: true, version: "fake-0" };
  }

  async openSession(input: OpenSessionInput): Promise<ProviderSession> {
    this.openedScopes.push(input.scopeKey);
    return {
      ref: { bindingId: input.bindingId, scopeKey: input.scopeKey, providerSessionId: `fake-${randomUUID()}` },
      createdAt: Date.now(),
    };
  }

  async resumeSession(ref: ProviderSessionRef): Promise<ProviderSession> {
    return { ref, createdAt: Date.now() };
  }

  async *runTurn(input: RunTurnInput): AsyncIterable<RuntimeEvent> {
    const turnId = randomUUID();
    yield { type: "turn.started", turnId };

    if (this.script === "approval-then-fail") {
      yield { type: "approval.requested", turnId, approvalId: randomUUID(), detail: "fake approval" };
      yield { type: "turn.failed", turnId, error: "scripted failure" };
      return;
    }

    yield { type: "assistant.delta", turnId, text: this.reply };
    yield { type: "turn.completed", turnId, text: this.reply };
  }

  async approve(input: ApprovalDecision): Promise<void> {
    this.approvals.push({ turnId: input.turnId, approvalId: input.approvalId, approved: input.approved });
  }

  async interrupt(turnId: string): Promise<void> {
    this.interrupts.push(turnId);
  }

  async closeSession(_ref: ProviderSessionRef): Promise<void> {
    // no-op for the fake
  }

  async shutdown(): Promise<void> {
    this.closed = true;
  }
}
