/**
 * Launch the real `codex app-server` over stdio and wrap it in a
 * `JsonRpcStdioConnection` (spec §5.4). Kept tiny and separate from the driver so
 * unit tests drive the FakeAppServer while integration/smoke tests use this.
 *
 * `codex exec` is NOT used here — it stays a diagnostics-only fallback, not the
 * long-lived Agent path.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonRpcStdioConnection } from "./jsonrpc-stdio.js";

export type SpawnedAppServer = {
  connection: JsonRpcStdioConnection;
  child: ChildProcessWithoutNullStreams;
  stop(): void;
};

/**
 * Spawn `codex app-server`. Provider credentials are read by codex from its own
 * environment/keychain — the runtime never puts the Agent token or provider key
 * into a prompt, tool result, or log (§10). We only wire stdio.
 */
export function spawnCodexAppServer(opts: { command?: string; args?: string[]; env?: NodeJS.ProcessEnv } = {}): SpawnedAppServer {
  const command = opts.command ?? "codex";
  const args = opts.args ?? ["app-server"];
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: opts.env ?? process.env,
  }) as ChildProcessWithoutNullStreams;

  const connection = new JsonRpcStdioConnection({
    write: (line) => {
      child.stdin.write(line);
    },
  });

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => connection.receive(chunk));
  child.on("exit", (code) => connection.close(new Error(`codex app-server exited (code ${code})`)));

  return {
    connection,
    child,
    stop() {
      connection.close(new Error("stopped"));
      child.kill("SIGTERM");
    },
  };
}
