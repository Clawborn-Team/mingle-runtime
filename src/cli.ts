/**
 * `mingle-runtime` CLI (spec §9.1). Two commands:
 *
 *   mingle-runtime add   --agent <id> --key <key> --im-url <url> --runtime <codex|claude-code>[,…] [--dir <path>] [--model <m>]
 *   mingle-runtime start
 *
 * `add` persists the binding(s) to ~/.mingle/config.json; `start` launches the
 * long-running daemon that drives every binding. The real provider assembly +
 * daemon launch is injected (`startRuntime`) so this is tested without spawning a
 * provider; the default implementation lives in ./runtime/factory.ts (imported
 * lazily so `add` never loads a provider SDK).
 *
 * OpenClaw is intentionally NOT a CLI runtime here — it installs via the
 * openclaw-mingle plugin, not this daemon.
 */
import {
  bindingsFromArgs,
  defaultConfigPath,
  loadConfig,
  saveConfig,
  upsertBinding,
  type RuntimeConfig,
} from "./install/config.js";
import { describeInstall } from "./install/describe.js";

const USAGE = [
  "mingle-runtime — drive your Mingle agent through a real provider",
  "",
  "  mingle-runtime add --agent <id> --key <key> --im-url <url> --runtime <codex|claude-code>[,…] [--dir <path>] [--model <m>]",
  "  mingle-runtime start",
].join("\n");

export type RuntimeHandle = { done: Promise<unknown>; stop: () => Promise<void> };

export type CliDeps = {
  configPath?: string;
  log?: (msg: string) => void;
  /** Launch the daemon for a config (injected for tests; default = real factory). */
  startRuntime?: (config: RuntimeConfig) => Promise<RuntimeHandle>;
};

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const log = deps.log ?? ((m) => console.log(m));
  const configPath = deps.configPath ?? defaultConfigPath();
  const [cmd, ...rest] = argv;

  if (cmd === "add") {
    let bindings;
    try {
      bindings = bindingsFromArgs(rest);
    } catch (err) {
      log((err as Error).message);
      return 1;
    }
    let cfg = await loadConfig(configPath);
    for (const b of bindings) cfg = upsertBinding(cfg, b);
    await saveConfig(cfg, configPath);
    for (const b of bindings) {
      log(`✓ bound ${b.agentId} → ${describeInstall(b.runtimeKind).label} (${b.runtimeKind})`);
    }
    log(`saved ${cfg.bindings.length} binding(s) to ${configPath}`);
    log("run `mingle-runtime start` to launch the daemon.");
    return 0;
  }

  if (cmd === "start") {
    const cfg = await loadConfig(configPath);
    if (cfg.bindings.length === 0) {
      log("no bindings configured. run `mingle-runtime add …` first.");
      return 1;
    }
    const start = deps.startRuntime ?? (await defaultStartRuntime());
    log(`starting mingle-runtime for ${cfg.bindings.length} binding(s)…`);
    const handle = await start(cfg);
    // Clean shutdown: on SIGINT/SIGTERM, stop the daemon so its disposers tear down
    // the spawned provider processes (codex app-server) instead of orphaning them.
    const shutdown = () => {
      log("shutting down mingle-runtime…");
      void Promise.resolve(handle.stop()).finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    await handle.done; // runs until the process is signalled
    return 0;
  }

  log(USAGE);
  return cmd ? 1 : 0;
}

/** Lazily load the real provider-backed launcher (keeps `add` provider-free). */
async function defaultStartRuntime(): Promise<(config: RuntimeConfig) => Promise<RuntimeHandle>> {
  const { startRuntime } = await import("./runtime/factory.js");
  return (config) => startRuntime(config);
}
