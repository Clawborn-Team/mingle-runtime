/**
 * Launch the real `codebuddy --acp` ACP server over stdio and wrap it in a
 * JsonRpcStdioConnection. Kept tiny + separate from the driver so unit-level work
 * stays offline while integration/smoke tests use this. codebuddy reads its own
 * Tencent auth from its environment — the runtime only wires stdio (spec §10).
 *
 * `codebuddy` is not always a bin on PATH: Tencent ships the CLI EMBEDDED in the
 * WorkBuddy desktop app (`WorkBuddy.app/Contents/Resources/app.asar/cli/bin/codebuddy`),
 * runnable via the app's bundled Electron in Node mode (`ELECTRON_RUN_AS_NODE=1`).
 * `resolveCodebuddyLauncher()` prefers a real `codebuddy` on PATH and falls back to
 * that embedded CLI, so onboarding works whether the user installed the standalone
 * CLI or just the desktop app. Verified end-to-end against WorkBuddy 2.106.4:
 * initialize → session/new → session/prompt streams `agent_message_chunk` → `end_turn`.
 */
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { JsonRpcStdioConnection } from "../codex/jsonrpc-stdio.js";

export type SpawnedAcpServer = {
  connection: JsonRpcStdioConnection;
  child: ChildProcessWithoutNullStreams;
  stop(): void;
};

/** How to invoke the codebuddy CLI: a base command + leading args + extra env. The
 *  caller appends its own args (e.g. `--acp`) after `args`. */
export type CodebuddyLauncher = { command: string; args: string[]; env: NodeJS.ProcessEnv };

/**
 * Resolve how to launch the codebuddy CLI, or `null` if neither the CLI nor the
 * WorkBuddy app is present. Order:
 *  1. `WORKBUDDY_CODEBUDDY` env → an explicit path to a codebuddy bin.
 *  2. `codebuddy` on PATH.
 *  3. The WorkBuddy desktop app's embedded CLI (macOS), run via its Electron in
 *     Node mode. Override the app location with `WORKBUDDY_APP`.
 */
export function resolveCodebuddyLauncher(): CodebuddyLauncher | null {
  const overrideBin = process.env.WORKBUDDY_CODEBUDDY;
  if (overrideBin && existsSync(overrideBin)) return { command: overrideBin, args: [], env: {} };

  if (commandRuns("codebuddy", [])) return { command: "codebuddy", args: [], env: {} };

  const candidateApps = [
    process.env.WORKBUDDY_APP,
    "/Applications/WorkBuddy.app",
    join(homedir(), "Applications/WorkBuddy.app"),
  ].filter((p): p is string => Boolean(p));
  for (const app of candidateApps) {
    const electron = join(app, "Contents/MacOS/Electron");
    const asar = join(app, "Contents/Resources/app.asar");
    // The CLI lives INSIDE app.asar (a single archive file), so we can't stat the
    // bin path directly — we check the Electron binary + the asar archive exist and
    // trust the in-asar path, which Electron resolves at runtime.
    if (existsSync(electron) && existsSync(asar)) {
      return {
        command: electron,
        args: [join(asar, "cli/bin/codebuddy")],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      };
    }
  }
  return null;
}

/** Whether a runnable codebuddy exists (CLI on PATH or embedded in WorkBuddy.app).
 *  Used by the real smoke tests to gate (skip loudly when absent). */
export function codebuddyAvailable(): boolean {
  const launcher = resolveCodebuddyLauncher();
  if (!launcher) return false;
  return commandRuns(launcher.command, launcher.args, launcher.env);
}

function commandRuns(command: string, baseArgs: string[], extraEnv: NodeJS.ProcessEnv = {}): boolean {
  try {
    execFileSync(command, [...baseArgs, "--version"], {
      stdio: "ignore",
      env: { ...process.env, ...extraEnv },
    });
    return true;
  } catch {
    return false;
  }
}

export function spawnWorkBuddyAcp(
  opts: {
    command?: string;
    args?: string[];
    /** Extra args appended after `--acp` on the default-launcher path (e.g.
     *  `--permission-mode bypassPermissions`). Ignored when `args` is given. */
    acpArgs?: string[];
    env?: NodeJS.ProcessEnv;
    /** OS process cwd for the codebuddy child. IMPORTANT: codebuddy's tools operate
     *  in the PROCESS cwd, not the `session/new` cwd param — so this is what bounds
     *  where the agent reads/writes. Defaults to the daemon's cwd when omitted. */
    cwd?: string;
  } = {},
): SpawnedAcpServer {
  let command = opts.command;
  let baseArgs: string[] = [];
  let baseEnv: NodeJS.ProcessEnv = {};
  if (!command) {
    const launcher = resolveCodebuddyLauncher();
    if (!launcher) {
      throw new Error(
        "codebuddy not found: install the `codebuddy` CLI on PATH or the WorkBuddy desktop app " +
          "(override with WORKBUDDY_CODEBUDDY=<bin> or WORKBUDDY_APP=<WorkBuddy.app>).",
      );
    }
    command = launcher.command;
    baseArgs = launcher.args;
    baseEnv = launcher.env;
  }
  const args = opts.args ?? [...baseArgs, "--acp", ...(opts.acpArgs ?? [])];
  const env = opts.env ?? { ...process.env, ...baseEnv };
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
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
