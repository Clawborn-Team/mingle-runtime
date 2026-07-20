/**
 * Launch the real `codebuddy --acp` ACP server over stdio and wrap it in a
 * JsonRpcStdioConnection. Kept tiny + separate from the driver so unit-level work
 * stays offline while integration/smoke tests use this. codebuddy reads its own
 * Tencent auth from its environment — the runtime only wires stdio (spec §10).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { JsonRpcStdioConnection } from "../codex/jsonrpc-stdio.js";

export type SpawnedAcpServer = {
  connection: JsonRpcStdioConnection;
  child: ChildProcessWithoutNullStreams;
  stop(): void;
};

export function spawnWorkBuddyAcp(
  opts: { command?: string; args?: string[]; env?: NodeJS.ProcessEnv } = {},
): SpawnedAcpServer {
  const command = opts.command ?? "codebuddy";
  const args = opts.args ?? ["--acp"];
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: opts.env ?? process.env,
  }) as ChildProcessWithoutNullStreams;

  const connection = new JsonRpcStdioConnection({ write: (line) => child.stdin.write(line) });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => connection.receive(chunk));
  // Drain stderr so a chatty codebuddy can't fill the pipe buffer and stall the turn
  // (same failure mode fixed for codex app-server).
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", () => {});
  child.on("exit", (code) => connection.close(new Error(`codebuddy --acp exited (code ${code})`)));

  return {
    connection,
    child,
    stop() {
      connection.close(new Error("stopped"));
      child.kill("SIGTERM");
    },
  };
}
