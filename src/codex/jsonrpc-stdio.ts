/**
 * JSON-RPC over stdio for the Codex App Server (spec §5.4). Framing is
 * newline-delimited JSON (JSONL) — one message per line, `"jsonrpc":"2.0"`
 * omitted on the wire, per the App Server protocol. This layer is transport-only:
 * it correlates request ids with responses, dispatches server notifications, and
 * answers server-initiated requests (Codex asks for approvals this way). It takes
 * an abstract line `write` sink so tests wire two peers in-memory with no child
 * process.
 */

type WriteLine = (line: string) => void;

export type NotificationHandler = (method: string, params: unknown) => void;
/** Answers a server-initiated request; the resolved value becomes the JSON-RPC result. */
export type RequestHandler = (method: string, params: unknown) => Promise<unknown>;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

type RpcMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export class JsonRpcStdioConnection {
  private readonly write: WriteLine;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private notificationHandler?: NotificationHandler;
  private requestHandler?: RequestHandler;
  private closed = false;

  constructor(opts: { write: WriteLine }) {
    this.write = opts.write;
  }

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler;
  }

  /** Send a request and await its correlated response. */
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("connection closed"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  /** Fire-and-forget notification (no id). */
  notify(method: string, params?: unknown): void {
    this.send({ method, params });
  }

  /** Feed raw bytes/chunks from the peer; reassembles JSONL lines. */
  receive(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.dispatch(line);
    }
  }

  /** Reject all in-flight requests; further calls fail fast. */
  close(reason?: Error): void {
    this.closed = true;
    const err = reason ?? new Error("connection closed");
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  private send(msg: RpcMessage): void {
    this.write(JSON.stringify(msg) + "\n");
  }

  private dispatch(line: string): void {
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      return; // ignore un-parseable lines rather than crash the connection
    }

    // A response to one of our requests: has id + (result|error), no method.
    if (msg.method === undefined && msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
      return;
    }

    // A server-initiated request: has method + id → we must answer.
    if (msg.method !== undefined && msg.id !== undefined) {
      void this.answerServerRequest(msg.id, msg.method, msg.params);
      return;
    }

    // A notification: method, no id.
    if (msg.method !== undefined) {
      this.notificationHandler?.(msg.method, msg.params);
    }
  }

  private async answerServerRequest(id: number | string, method: string, params: unknown): Promise<void> {
    if (!this.requestHandler) {
      this.send({ id, error: { code: -32601, message: `no handler for ${method}` } });
      return;
    }
    try {
      const result = await this.requestHandler(method, params);
      this.send({ id, result });
    } catch (err) {
      this.send({ id, error: { code: -32000, message: err instanceof Error ? err.message : String(err) } });
    }
  }
}
