/**
 * Typed Codex App Server client (spec §5.4) over a JSON-RPC/stdio connection.
 * Wraps the raw methods (initialize / thread.start|resume|fork / turn.start|
 * interrupt) and exposes the server's notification stream. A started turn hands
 * back a `completed` promise that settles on the matching `turn/completed`
 * notification, so callers await one turn without racing ids.
 */
import type { JsonRpcStdioConnection, NotificationHandler } from "./jsonrpc-stdio.js";

export type ApprovalPolicy = "never" | "onRequest" | "unlessTrusted";

export type SandboxPolicy =
  | { type: "readOnly" }
  | { type: "workspaceWrite"; writableRoots?: string[]; networkAccess?: boolean }
  | { type: "dangerFullAccess" };

export type ThreadStartParams = {
  model?: string;
  cwd?: string;
  approvalPolicy?: ApprovalPolicy;
  sandbox?: SandboxPolicy;
};

export type TurnStartParams = {
  threadId: string;
  text: string;
  cwd?: string;
  approvalPolicy?: ApprovalPolicy;
  sandboxPolicy?: SandboxPolicy;
  model?: string;
  effort?: "low" | "medium" | "high";
};

export type TurnStatus = "completed" | "interrupted" | "failed";

export type StartedTurn = {
  turnId: string;
  /** Resolves to the final status when `turn/completed` for this turn arrives. */
  completed: Promise<{ status: TurnStatus; error?: string }>;
};

export type CodexThreadSummary = { id: string; cwd?: string; updatedAt?: string; updated_at?: string };

export class CodexAppServerClient {
  private readonly conn: JsonRpcStdioConnection;
  /** turnId → resolver for its completion promise (set when a caller awaits). */
  private readonly awaitingCompletion = new Map<string, (r: { status: TurnStatus; error?: string }) => void>();
  /** Completions that arrived before their waiter registered (fast fake / real
   *  server can emit turn/completed the instant turn/start resolves). */
  private readonly earlyCompletions = new Map<string, { status: TurnStatus; error?: string }>();

  constructor(conn: JsonRpcStdioConnection) {
    this.conn = conn;
    // Settle any awaited turn on its completion notification.
    conn.onNotification((method, params) => {
      if (method === "turn/completed") {
        const turn = (params as any)?.turn ?? {};
        const result = { status: turn.status as TurnStatus, error: turn.error?.message };
        const resolve = this.awaitingCompletion.get(turn.id);
        if (resolve) {
          this.awaitingCompletion.delete(turn.id);
          resolve(result);
        } else {
          this.earlyCompletions.set(turn.id, result);
        }
      }
      this.externalNotification?.(method, params);
    });
  }

  private externalNotification?: NotificationHandler;

  /** Subscribe to ALL server notifications; returns an unsubscribe fn. */
  onNotification(handler: NotificationHandler): () => void {
    this.externalNotification = handler;
    return () => {
      if (this.externalNotification === handler) this.externalNotification = undefined;
    };
  }

  async initialize(clientInfo: { name: string; version: string; title?: string }): Promise<void> {
    await this.conn.request("initialize", {
      clientInfo,
      capabilities: { experimentalApi: true },
    });
    this.conn.notify("initialized", {});
  }

  async threadStart(params: ThreadStartParams): Promise<{ threadId: string; sessionId?: string }> {
    const res = (await this.conn.request("thread/start", params)) as any;
    return { threadId: res.thread.id, sessionId: res.thread.sessionId };
  }

  async threadResume(threadId: string): Promise<{ threadId: string; sessionId?: string }> {
    const res = (await this.conn.request("thread/resume", { threadId })) as any;
    return { threadId: res.thread.id, sessionId: res.thread.sessionId };
  }

  async threadFork(threadId: string, lastTurnId?: string): Promise<{ threadId: string; forkedFromId?: string }> {
    const res = (await this.conn.request("thread/fork", { threadId, lastTurnId })) as any;
    return { threadId: res.thread.id, forkedFromId: res.thread.forkedFromId };
  }

  async threadList(params: { limit?: number } = {}): Promise<CodexThreadSummary[]> {
    const res = (await this.conn.request("thread/list", params)) as any;
    return (res.data ?? res.threads ?? []).map((thread: any) => ({
      id: String(thread.id),
      ...(thread.cwd ? { cwd: String(thread.cwd) } : {}),
      ...(thread.updatedAt ? { updatedAt: String(thread.updatedAt) } : {}),
      ...(thread.updated_at ? { updated_at: String(thread.updated_at) } : {}),
    }));
  }

  async threadRead(id: string, includeTurns = true): Promise<{ id: string; turns: Array<Record<string, unknown>> }> {
    const res = (await this.conn.request("thread/read", { threadId: id, includeTurns })) as any;
    const thread = res.thread ?? res;
    return { id: String(thread.id ?? id), turns: thread.turns ?? [] };
  }

  async turnStart(params: TurnStartParams): Promise<StartedTurn> {
    const res = (await this.conn.request("turn/start", {
      threadId: params.threadId,
      input: [{ type: "text", text: params.text }],
      ...(params.cwd ? { cwd: params.cwd } : {}),
      ...(params.approvalPolicy ? { approvalPolicy: params.approvalPolicy } : {}),
      ...(params.sandboxPolicy ? { sandboxPolicy: params.sandboxPolicy } : {}),
      ...(params.model ? { model: params.model } : {}),
      ...(params.effort ? { effort: params.effort } : {}),
    })) as any;
    const turnId: string = res.turn.id;
    const completed = new Promise<{ status: TurnStatus; error?: string }>((resolve) => {
      // If turn/completed already arrived, settle immediately; else wait for it.
      const early = this.earlyCompletions.get(turnId);
      if (early) {
        this.earlyCompletions.delete(turnId);
        resolve(early);
      } else {
        this.awaitingCompletion.set(turnId, resolve);
      }
    });
    return { turnId, completed };
  }

  async turnInterrupt(threadId: string, turnId: string): Promise<void> {
    await this.conn.request("turn/interrupt", { threadId, turnId });
  }

  /** Answer a server-initiated approval request (wired by the driver). */
  onServerRequest(handler: (method: string, params: unknown) => Promise<unknown>): void {
    this.conn.onRequest(handler);
  }
}
