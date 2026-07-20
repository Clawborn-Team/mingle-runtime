/**
 * Typed ACP client (spec §5) over a JSON-RPC/stdio connection. Wraps the standard
 * ACP methods (initialize / session.new|load|prompt|cancel) and exposes the
 * server's notification + reverse-request streams. In ACP, `session/prompt` is a
 * REQUEST that resolves with `{ stopReason }` at turn end, while `session/update`
 * notifications stream during it — so a turn needs no separate completion race.
 */
import type { JsonRpcStdioConnection, NotificationHandler } from "../codex/jsonrpc-stdio.js";

const PROTOCOL_VERSION = 1;

export class WorkBuddyAcpClient {
  private readonly conn: JsonRpcStdioConnection;

  constructor(conn: JsonRpcStdioConnection) {
    this.conn = conn;
  }

  /** Negotiate version + capabilities; report whether the agent supports session/load. */
  async initialize(clientInfo: { name: string; version: string }): Promise<{ loadSession: boolean }> {
    const res = (await this.conn.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo,
      // Minimal client capabilities: no fs/terminal proxy → codebuddy self-executes
      // in its own sandbox (spec §5).
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    })) as { agentCapabilities?: { loadSession?: boolean } };
    return { loadSession: res.agentCapabilities?.loadSession === true };
  }

  async sessionNew(params: { cwd?: string }): Promise<{ sessionId: string }> {
    const res = (await this.conn.request("session/new", {
      ...(params.cwd ? { cwd: params.cwd } : {}),
      mcpServers: [],
    })) as { sessionId: string };
    return { sessionId: res.sessionId };
  }

  async sessionLoad(params: { sessionId: string; cwd?: string }): Promise<void> {
    await this.conn.request("session/load", {
      sessionId: params.sessionId,
      ...(params.cwd ? { cwd: params.cwd } : {}),
      mcpServers: [],
    });
  }

  async sessionPrompt(params: { sessionId: string; text: string }): Promise<{ stopReason: string }> {
    const res = (await this.conn.request("session/prompt", {
      sessionId: params.sessionId,
      prompt: [{ type: "text", text: params.text }],
    })) as { stopReason?: string };
    return { stopReason: res.stopReason ?? "end_turn" };
  }

  sessionCancel(sessionId: string): void {
    this.conn.notify("session/cancel", { sessionId });
  }

  onNotification(handler: NotificationHandler): () => void {
    this.conn.onNotification(handler);
    return () => this.conn.onNotification(() => {});
  }

  onServerRequest(handler: (method: string, params: unknown) => Promise<unknown>): void {
    this.conn.onRequest(handler);
  }
}
