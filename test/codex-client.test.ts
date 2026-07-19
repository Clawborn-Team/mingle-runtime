import { describe, it, expect } from "vitest";
import { JsonRpcStdioConnection } from "../src/codex/jsonrpc-stdio.js";
import { FakeAppServer } from "../src/codex/fake-app-server.js";
import { CodexAppServerClient } from "../src/codex/client.js";

/** Wire a client connection to a FakeAppServer over an in-memory duplex. */
function connectClient(server = new FakeAppServer()) {
  let client!: JsonRpcStdioConnection;
  const serverConn = new JsonRpcStdioConnection({ write: (line) => client.receive(line) });
  client = new JsonRpcStdioConnection({ write: (line) => serverConn.receive(line) });
  server.attach(serverConn);
  return { client: new CodexAppServerClient(client), server };
}

describe("CodexAppServerClient over FakeAppServer", () => {
  it("initializes then starts a thread", async () => {
    const { client } = connectClient();
    await client.initialize({ name: "mingle-runtime", version: "0" });
    const thread = await client.threadStart({ cwd: "/tmp", approvalPolicy: "never" });
    expect(thread.threadId).toMatch(/^thr_/);
  });

  it("resumes an existing thread by id", async () => {
    const { client } = connectClient();
    await client.initialize({ name: "c", version: "0" });
    const started = await client.threadStart({});
    const resumed = await client.threadResume(started.threadId);
    expect(resumed.threadId).toBe(started.threadId);
  });

  it("streams a turn's notifications: turn/started → delta → item/completed → turn/completed", async () => {
    const { client } = connectClient(new FakeAppServer({ reply: "嗨！" }));
    await client.initialize({ name: "c", version: "0" });
    const thread = await client.threadStart({});
    const seen: string[] = [];
    const texts: string[] = [];
    const done = client.onNotification((method, params) => {
      seen.push(method);
      if (method === "item/agentMessage/delta") texts.push((params as any).delta ?? (params as any).text);
    });
    const turn = await client.turnStart({ threadId: thread.threadId, text: "hi" });
    await turn.completed;
    done();
    expect(seen).toContain("turn/started");
    expect(seen).toContain("turn/completed");
    expect(texts.join("")).toContain("嗨！");
  });

  it("interrupts a turn (status interrupted)", async () => {
    const { client } = connectClient(new FakeAppServer({ script: "await-interrupt" }));
    await client.initialize({ name: "c", version: "0" });
    const thread = await client.threadStart({});
    let finalStatus = "";
    const off = client.onNotification((method, params) => {
      if (method === "turn/completed") finalStatus = (params as any).turn.status;
    });
    const turn = await client.turnStart({ threadId: thread.threadId, text: "long task" });
    await client.turnInterrupt(thread.threadId, turn.turnId);
    await turn.completed;
    off();
    expect(finalStatus).toBe("interrupted");
  });
});
