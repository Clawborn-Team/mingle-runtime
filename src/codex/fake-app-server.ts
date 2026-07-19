/**
 * FakeAppServer — an in-memory peer that speaks the Codex App Server JSONL
 * protocol (spec §5.4), so the client + driver are proven without spawning the
 * real `codex` binary. It answers initialize / thread-start / thread-resume /
 * thread-fork / turn-start / turn-interrupt and emits the notification sequence
 * a real turn produces. Scriptable for the edge cases the merge gate needs:
 * approval-request, failed turn, and an interruptible long turn.
 */
import { randomUUID } from "node:crypto";
import type { JsonRpcStdioConnection } from "./jsonrpc-stdio.js";

export type FakeScript = "reply" | "approval-then-complete" | "fail" | "await-interrupt";

export type FakeAppServerOptions = {
  reply?: string;
  script?: FakeScript;
};

export class FakeAppServer {
  private conn?: JsonRpcStdioConnection;
  private readonly reply: string;
  private readonly script: FakeScript;
  /** threadId → turnId currently interruptible (for await-interrupt). */
  private readonly openTurns = new Map<string, { interrupt: () => void }>();
  /** The `input` arrays received on turn/start — so tests can inspect the actual
   *  provider input the driver produced (P1-5 acceptance). */
  readonly turnInputs: unknown[] = [];

  constructor(opts: FakeAppServerOptions = {}) {
    this.reply = opts.reply ?? "ok";
    this.script = opts.script ?? "reply";
  }

  /** Bind to a connection whose peer is the client. */
  attach(conn: JsonRpcStdioConnection): void {
    this.conn = conn;
    conn.onRequest((method, params) => this.handle(method, params));
  }

  private notify(method: string, params: unknown): void {
    this.conn?.notify(method, params);
  }

  private async handle(method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, any>;
    switch (method) {
      case "initialize":
        return { serverInfo: { name: "fake-codex", version: "0" }, capabilities: {} };
      case "initialized":
        return {};
      case "thread/start":
        return { thread: { id: `thr_${randomUUID()}`, sessionId: `sess_${randomUUID()}` } };
      case "thread/resume":
        return { thread: { id: p.threadId, sessionId: `sess_${randomUUID()}` } };
      case "thread/fork":
        return { thread: { id: `thr_${randomUUID()}`, forkedFromId: p.threadId } };
      case "turn/start":
        this.turnInputs.push(p.input);
        return this.startTurn(p.threadId as string);
      case "turn/interrupt": {
        const open = this.openTurns.get(p.threadId as string);
        open?.interrupt();
        return {};
      }
      default:
        throw new Error(`fake app-server: unhandled ${method}`);
    }
  }

  private startTurn(threadId: string): { turn: { id: string; status: string; items: [] } } {
    const turnId = `turn_${randomUUID()}`;
    // Drive the notification sequence on the next tick so the caller has the
    // turn id (mirrors the real server streaming after the turn/start result).
    queueMicrotask(() => void this.emitTurn(threadId, turnId));
    return { turn: { id: turnId, status: "inProgress", items: [] } };
  }

  private async emitTurn(threadId: string, turnId: string): Promise<void> {
    this.notify("turn/started", { turn: { id: turnId, threadId, status: "inProgress" } });

    if (this.script === "await-interrupt") {
      // Hang until interrupted, then complete with status "interrupted".
      await new Promise<void>((resolve) => {
        this.openTurns.set(threadId, {
          interrupt: () => {
            this.notify("turn/completed", { turn: { id: turnId, threadId, status: "interrupted" } });
            resolve();
          },
        });
      });
      this.openTurns.delete(threadId);
      return;
    }

    if (this.script === "fail") {
      this.notify("turn/completed", { turn: { id: turnId, threadId, status: "failed", error: { message: "boom" } } });
      return;
    }

    if (this.script === "approval-then-complete") {
      const itemId = `item_${randomUUID()}`;
      // Server-initiated approval request; the driver must answer it.
      const decision = await this.conn?.request("item/commandExecution/requestApproval", {
        itemId,
        threadId,
        turnId,
        command: "rm -rf ./build",
        cwd: "/tmp",
      });
      this.notify("item/completed", {
        item: { id: itemId, type: "commandExecution", approved: decision === "accept" || decision === "acceptForSession" },
      });
    }

    const itemId = `item_${randomUUID()}`;
    this.notify("item/started", { item: { id: itemId, type: "agentMessage" } });
    this.notify("item/agentMessage/delta", { itemId, delta: this.reply });
    this.notify("item/completed", { item: { id: itemId, type: "agentMessage", text: this.reply } });
    this.notify("turn/completed", { turn: { id: turnId, threadId, status: "completed" } });
  }
}
