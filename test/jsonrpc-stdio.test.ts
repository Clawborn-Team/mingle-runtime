import { describe, it, expect } from "vitest";
import { JsonRpcStdioConnection } from "../src/codex/jsonrpc-stdio.js";

/** Wire two connections together over in-memory line sinks (each writes lines the
 *  other receives), so we can exercise the framing without a child process. */
function connectPair() {
  let a!: JsonRpcStdioConnection;
  let b!: JsonRpcStdioConnection;
  a = new JsonRpcStdioConnection({ write: (line) => b.receive(line) });
  b = new JsonRpcStdioConnection({ write: (line) => a.receive(line) });
  return { a, b };
}

describe("JsonRpcStdioConnection", () => {
  it("correlates a request with its response", async () => {
    const { a, b } = connectPair();
    b.onRequest(async (method, params) => {
      expect(method).toBe("thread/start");
      return { thread: { id: "thr_1" }, echoed: params };
    });
    const res = await a.request("thread/start", { model: "gpt-5.4" });
    expect((res as any).thread.id).toBe("thr_1");
    expect((res as any).echoed).toEqual({ model: "gpt-5.4" });
  });

  it("delivers a server notification to the handler", async () => {
    const { a, b } = connectPair();
    const seen: { method: string; params: unknown }[] = [];
    a.onNotification((method, params) => seen.push({ method, params }));
    b.notify("turn/started", { turn: { id: "turn_1" } });
    // notifications are dispatched synchronously on receive
    expect(seen).toEqual([{ method: "turn/started", params: { turn: { id: "turn_1" } } }]);
  });

  it("answers a server-initiated request and frames the result back", async () => {
    const { a, b } = connectPair();
    a.onRequest(async (method) => {
      if (method === "item/commandExecution/requestApproval") return "accept";
      throw new Error("unexpected");
    });
    const decision = await b.request("item/commandExecution/requestApproval", { itemId: "i1" });
    expect(decision).toBe("accept");
  });

  it("reassembles a JSON message split across chunks (partial-line buffering)", async () => {
    const seen: unknown[] = [];
    const conn = new JsonRpcStdioConnection({ write: () => {} });
    conn.onNotification((method, params) => seen.push({ method, params }));
    const full = JSON.stringify({ method: "turn/completed", params: { turn: { status: "completed" } } }) + "\n";
    conn.receive(full.slice(0, 20));
    conn.receive(full.slice(20));
    expect(seen).toEqual([{ method: "turn/completed", params: { turn: { status: "completed" } } }]);
  });

  it("rejects a pending request when the connection closes", async () => {
    // Standalone connection with no peer answering — the request stays in-flight
    // until close() rejects it.
    const conn = new JsonRpcStdioConnection({ write: () => {} });
    const p = conn.request("turn/start", {});
    conn.close(new Error("app-server exited"));
    await expect(p).rejects.toThrow(/app-server exited/);
  });
});
