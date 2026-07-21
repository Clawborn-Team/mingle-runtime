/**
 * ClaudeAgentDriver (spec §5.5) — an `AgentRuntimeDriver` backed by the Claude
 * Agent SDK's `query()`. A scope_key maps to an explicit Claude `session_id`
 * (captured from the init/result message); the next wake on that scope resumes it
 * via `resume: <id>` — we NEVER use `continue: true` (that guesses "most recent in
 * cwd", §5.5). The SDK message stream is mapped to unified `RuntimeEvent`s.
 *
 * Permissions run through `canUseTool` (PreToolUse-style): a denied tool is
 * refused locally, so the model can't run something the binding's profile forbids.
 * Mingle capabilities are exposed as an in-process SDK-MCP tool with a restricted
 * schema, so the model never holds a long-lived Agent credential (§10). `claude -p`
 * stays a diagnostics-only fallback — the SDK is the path.
 *
 * The SDK `query` is injected (structural `QueryFn`) so the core is dependency-free
 * and unit-testable; the real SDK is dynamic-imported only in the smoke path.
 */
import type {
  AgentRuntimeDriver,
  ApprovalDecision,
  OpenSessionInput,
  ProviderSession,
  ProviderSessionRef,
  QuestionBlock,
  RunTurnInput,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeProbe,
} from "../runtime/driver.js";
import type { CanUseTool, QueryFn, QueryOptions, SdkMessage } from "./sdk-types.js";
import { detectClaudeAuth } from "./auth.js";
import { ownerContextTask, renderWakeInput, type OwnerContextTask } from "../runtime/wake-render.js";

export type ClaudeDriverOptions = {
  query: QueryFn;
  /** Stable per-binding workspace; resume needs the same cwd (SDK stores under it). */
  cwd?: string;
  allowedTools?: string[];
  /** In-process Mingle MCP servers (createSdkMcpServer output). */
  mcpServers?: Record<string, unknown>;
  model?: string;
  /** Tools the model may never run regardless of allowedTools (deny-list). */
  deniedTools?: string[];
  /** Local Agent persona prepended to each turn (so Claude answers as this agent). */
  persona?: string;
  /** SDK permission mode. "bypassPermissions" = YOLO (no prompts, full access). */
  permissionMode?: string;
  ownerContext?: (task: OwnerContextTask) => Promise<string>;
};

const DEFAULT_DENIED = ["Bash"];

export class ClaudeAgentDriver implements AgentRuntimeDriver {
  readonly kind = "claude-code" as const;
  readonly capabilities: RuntimeCapabilities = {
    streaming: true,
    tools: true,
    approvals: true,
    fileChanges: true,
    resume: true,
    imageInputs: "local-file",
  };

  private readonly query: QueryFn;
  private readonly opts: ClaudeDriverOptions;
  private readonly deniedTools: Set<string>;

  constructor(opts: ClaudeDriverOptions) {
    this.query = opts.query;
    this.opts = opts;
    this.deniedTools = new Set(opts.deniedTools ?? DEFAULT_DENIED);
  }

  async probe(): Promise<RuntimeProbe> {
    // Honest auth surfacing (§5.5) — real methods only.
    return detectClaudeAuth();
  }

  async openSession(input: OpenSessionInput): Promise<ProviderSession> {
    // Mint a session by priming an empty-prompt query; capture its session_id.
    let sessionId: string | undefined;
    for await (const msg of this.query({ prompt: "", options: { cwd: input.cwd ?? this.opts.cwd } })) {
      sessionId ??= sessionIdOf(msg);
    }
    if (!sessionId) throw new Error("claude driver: no session_id from priming query");
    return {
      ref: { bindingId: input.bindingId, scopeKey: input.scopeKey, providerSessionId: sessionId },
      createdAt: Date.now(),
    };
  }

  async resumeSession(ref: ProviderSessionRef): Promise<ProviderSession> {
    // Nothing to call yet — the id is resumed on the next runTurn via `resume`.
    return { ref: { ...ref }, createdAt: Date.now() };
  }

  runTurn(input: RunTurnInput): AsyncIterable<RuntimeEvent> {
    return this.streamTurn(input);
  }

  private async *streamTurn(input: RunTurnInput): AsyncIterable<RuntimeEvent> {
    const task = ownerContextTask(input.packet);
    const material = this.opts.ownerContext && task
      ? await this.opts.ownerContext(task)
      : undefined;
    const prompt = renderWakeInput(input.packet, this.opts.persona, material);
    const turnId = `turn-${input.session.ref.providerSessionId}-${Date.now()}`;
    yield { type: "turn.started", turnId };

    const options: QueryOptions = {
      resume: input.session.ref.providerSessionId, // explicit id — never continue:true
      cwd: this.opts.cwd,
      ...(this.opts.allowedTools ? { allowedTools: this.opts.allowedTools } : {}),
      ...(this.opts.mcpServers ? { mcpServers: this.opts.mcpServers } : {}),
      ...(this.opts.model ? { model: this.opts.model } : {}),
      ...(this.opts.permissionMode ? { permissionMode: this.opts.permissionMode } : {}),
      canUseTool: this.buildCanUseTool(),
    };

    let assembled = "";
    let failed: string | undefined;
    let asked = false;
    try {
      outer: for await (const msg of this.query({ prompt, options })) {
        for (const ev of this.mapMessage(msg, turnId)) {
          if (ev.type === "assistant.delta") assembled += ev.text;
          if (ev.type === "turn.failed") failed = ev.error;
          yield ev;
          if (ev.type === "question.raised") {
            // Native AskUserQuestion: end THIS round now (spec §5.2, approach #1). The
            // answer arrives as a later wake that resumes the session. Breaking the
            // for-await calls the query iterator's return(), terminating the SDK turn.
            asked = true;
            break outer;
          }
        }
      }
    } catch (err) {
      yield { type: "turn.failed", turnId, error: err instanceof Error ? err.message : String(err) };
      return;
    }

    if (asked) {
      // A question turn has no plaintext reply to deliver; the consumer builds the
      // structured message from the question.raised block(s). body stays a short fallback.
      yield { type: "turn.completed", turnId };
      return;
    }
    if (!failed) yield { type: "turn.completed", turnId, text: assembled || undefined };
  }

  /** Translate one SDK message into zero or more RuntimeEvents. */
  private *mapMessage(msg: SdkMessage, turnId: string): Iterable<RuntimeEvent> {
    if (msg.type === "assistant" && "message" in msg) {
      const content = (msg as { message?: { content?: Array<Record<string, unknown>> } }).message?.content ?? [];
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          yield { type: "assistant.delta", turnId, text: block.text };
        } else if (block.type === "tool_use" && block.name === "AskUserQuestion") {
          // Native structured ask: surface as question.raised, never as a plain tool call.
          yield* mapAskUserQuestion(block, turnId);
        } else if (block.type === "tool_use") {
          yield { type: "tool.started", turnId, toolId: String(block.id ?? ""), name: String(block.name ?? "") };
        }
      }
      return;
    }
    if (msg.type === "result") {
      const subtype = (msg as { subtype?: string }).subtype;
      if (subtype && subtype !== "success") {
        const errors = (msg as { errors?: string[] }).errors;
        yield { type: "turn.failed", turnId, error: errors?.join("; ") ?? subtype };
      }
    }
  }

  /** PreToolUse-style permission gate (§5.5): deny-list wins; allow-list gates the rest. */
  private buildCanUseTool(): CanUseTool {
    const allowed = this.opts.allowedTools;
    const denied = this.deniedTools;
    return async (toolName, input) => {
      // AskUserQuestion is intercepted by the driver (surfaced as a structured question
      // and the round ends). Deny the native prompt so the real SDK never blocks on it.
      if (toolName === "AskUserQuestion") return { behavior: "deny", message: "handled by mingle as a structured question" };
      if (denied.has(toolName)) return { behavior: "deny", message: `${toolName} is not permitted for this agent` };
      if (allowed && allowed.length > 0 && !allowed.includes(toolName) && !toolName.startsWith("mcp__")) {
        return { behavior: "deny", message: `${toolName} is not in the allowed tools` };
      }
      return { behavior: "allow", updatedInput: input };
    };
  }

  async approve(_input: ApprovalDecision): Promise<void> {
    // The SDK resolves permission inline via canUseTool; no out-of-band approval
    // queue in V1. (A richer owner-in-the-loop approval maps here later.)
  }

  async interrupt(_turnId: string): Promise<void> {
    // Cooperative interrupt is via the AbortController wired at the call site in
    // a later increment; no-op in V1.
  }

  async closeSession(_ref: ProviderSessionRef): Promise<void> {
    // Sessions persist on disk; nothing to tear down per-scope.
  }

  async shutdown(): Promise<void> {
    // No long-lived child — each query() call is self-contained.
  }
}

function sessionIdOf(msg: SdkMessage): string | undefined {
  if ((msg.type === "system" || msg.type === "result") && "session_id" in msg) {
    return (msg as { session_id?: string }).session_id;
  }
  return undefined;
}

/**
 * Map a native Claude `AskUserQuestion` tool_use into one `question.raised` event per
 * question (spec §5.3). The tool input is `{ questions: [{ question, header, multiSelect,
 * options: [{ label, description }] }] }`. Each question_id is derived from the tool_use id
 * + index so the answer round-trip can correlate it back to this turn's session.
 */
function* mapAskUserQuestion(block: Record<string, unknown>, turnId: string): Iterable<RuntimeEvent> {
  const toolUseId = String(block.id ?? "aq");
  const input = (block.input ?? {}) as { questions?: unknown };
  const questions = Array.isArray(input.questions) ? input.questions : [];
  for (let i = 0; i < questions.length; i++) {
    const q = (questions[i] ?? {}) as { question?: unknown; multiSelect?: unknown; options?: unknown };
    const prompt = typeof q.question === "string" ? q.question : "";
    if (!prompt) continue;
    const rawOptions = Array.isArray(q.options) ? q.options : [];
    const options = rawOptions
      .map((o, oi) => {
        const opt = (o ?? {}) as { label?: unknown };
        const label = typeof opt.label === "string" ? opt.label : "";
        return label ? { id: `${toolUseId}-${i}-${oi}`, label } : undefined;
      })
      .filter((o): o is { id: string; label: string } => o !== undefined);
    const questionId = `${toolUseId}-${i}`;
    const questionBlock: QuestionBlock = {
      type: "question",
      question_id: questionId,
      prompt,
      ...(options.length > 0 ? { options } : {}),
      allow_multiple: q.multiSelect === true,
      allow_free_text: options.length === 0,
      status: "open",
    };
    yield { type: "question.raised", turnId, questionId, block: questionBlock };
  }
}
