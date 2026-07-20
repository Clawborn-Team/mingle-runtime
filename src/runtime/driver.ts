/**
 * AgentRuntimeDriver contract (spec §5.2). This replaces the old
 * `respond(prompt): Promise<string>` shape: a turn now STREAMS structured
 * `RuntimeEvent`s, sessions are explicit + resumable, and each driver DECLARES
 * its capabilities so the runtime degrades the UI honestly (§9.2) instead of
 * faking events a provider can't produce.
 *
 * Drivers (openclaw / claude-code / codex) share nothing but this interface —
 * they never import each other, and heavy provider deps install per chosen driver.
 */
import type { WakePacket } from "../protocol/wake-packet.js";

export type RuntimeKind = "openclaw" | "claude-code" | "codex" | "workbuddy";

/** The unified turn event stream (spec §5.2). Not every provider emits every
 *  variant — capabilities say which are real; the runtime never fabricates the rest. */
export type RuntimeEvent =
  | { type: "turn.started"; turnId: string }
  | { type: "assistant.delta"; turnId: string; text: string }
  | { type: "tool.started"; turnId: string; toolId: string; name: string }
  | { type: "tool.completed"; turnId: string; toolId: string; ok: boolean; detail?: string }
  | { type: "approval.requested"; turnId: string; approvalId: string; detail: string }
  | { type: "file.changed"; turnId: string; path: string }
  | { type: "turn.completed"; turnId: string; text?: string }
  | { type: "turn.failed"; turnId: string; error: string };

/** What a driver can actually do — drives honest UI degrade (§9.2). */
export type RuntimeCapabilities = {
  streaming: boolean;
  tools: boolean;
  approvals: boolean;
  fileChanges: boolean;
  resume: boolean;
};

export type RuntimeProbe = {
  kind: RuntimeKind;
  available: boolean;
  version?: string;
  /** Honest auth surfacing (§5.5): what credentials are actually usable. */
  auth?: { method: string; ok: boolean; detail?: string }[];
  detail?: string;
};

/** A live provider session (thread) for one (binding, scope_key). */
export type ProviderSession = {
  ref: ProviderSessionRef;
  createdAt: number;
};

/** The persistable handle the Session Registry stores (spec §5.3). */
export type ProviderSessionRef = {
  bindingId: string;
  scopeKey: string;
  /** provider_session_id / thread_id */
  providerSessionId: string;
};

export type OpenSessionInput = {
  bindingId: string;
  scopeKey: string;
  /** Working directory / workspace the turn may read (per-turn cwd, §5.4). */
  cwd?: string;
  /** Trusted Mingle instruction bundle injected on session creation (§5.3). */
  instructionBundle?: string;
};

export type RunTurnInput = {
  session: ProviderSession;
  packet: WakePacket;
  /** Abort the turn cooperatively (maps to provider interrupt). */
  signal?: AbortSignal;
};

export type ApprovalDecision = {
  turnId: string;
  approvalId: string;
  approved: boolean;
  note?: string;
};

export interface AgentRuntimeDriver {
  readonly kind: RuntimeKind;
  readonly capabilities: RuntimeCapabilities;

  probe(): Promise<RuntimeProbe>;
  openSession(input: OpenSessionInput): Promise<ProviderSession>;
  resumeSession(ref: ProviderSessionRef): Promise<ProviderSession>;
  runTurn(input: RunTurnInput): AsyncIterable<RuntimeEvent>;
  approve(input: ApprovalDecision): Promise<void>;
  interrupt(turnId: string): Promise<void>;
  closeSession(ref: ProviderSessionRef): Promise<void>;
  shutdown(): Promise<void>;
}
