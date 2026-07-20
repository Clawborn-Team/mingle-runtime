/**
 * `mingle-runtime` CLI. Commands:
 *
 *   mingle-runtime add    --agent <id> --key <key> --im-url <url> --runtime <codex|claude-code>[,…] [--dir <path>] [--model <m>]
 *   mingle-runtime setup  (add …) --install-url <tarball>    # add + print a concise onboarding guide for the calling agent
 *   mingle-runtime start                                     # singleton daemon driving every binding
 *
 * `add` persists binding(s) to ~/.mingle/config.json; `start` launches the daemon
 * (SINGLETON — a second start replaces the previous daemon so one machine has one
 * Event Center consumer). `setup` is what the owner's codex/Claude runs from the
 * short paste-in prompt: it configures + prints the onboarding steps (introduce
 * Mingle, ask the owner name/intent/interests, save to the profile). The api-key is
 * written to config by `add`; onboarding reads it back from there (never re-typed).
 */
import {
  bindingsFromArgs,
  defaultConfigPath,
  loadConfig,
  saveConfig,
  upsertBinding,
  type InstalledBinding,
  type RuntimeConfig,
} from "./install/config.js";
import { describeInstall } from "./install/describe.js";
import { ensureSingleton as realEnsureSingleton, releaseSingleton as realReleaseSingleton } from "./runtime/singleton.js";

const USAGE = [
  "mingle-runtime — drive your Mingle agent through a real provider",
  "",
  "  mingle-runtime add --agent <id> --key <key> --im-url <url> --runtime <codex|claude-code>[,…] [--dir <path>] [--model <m>]",
  "  mingle-runtime setup … --install-url <tarball>   # configure + print onboarding steps",
  "  mingle-runtime start                              # launch the (singleton) daemon",
].join("\n");

export type RuntimeHandle = { done: Promise<unknown>; stop: () => Promise<void> };

export type CliDeps = {
  configPath?: string;
  log?: (msg: string) => void;
  /** Launch the daemon for a config (injected for tests; default = real factory). */
  startRuntime?: (config: RuntimeConfig) => Promise<RuntimeHandle>;
  /** Singleton lock (injected for tests so they don't touch ~/.mingle). */
  ensureSingleton?: (pid: number) => Promise<void>;
  releaseSingleton?: (pid: number) => void;
};

async function persistBindings(rest: string[], configPath: string): Promise<InstalledBinding[]> {
  const bindings = bindingsFromArgs(rest);
  let cfg = await loadConfig(configPath);
  for (const b of bindings) cfg = upsertBinding(cfg, b);
  await saveConfig(cfg, configPath);
  return bindings;
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const log = deps.log ?? ((m) => console.log(m));
  const configPath = deps.configPath ?? defaultConfigPath();
  const [cmd, ...rest] = argv;

  if (cmd === "add") {
    let bindings: InstalledBinding[];
    try {
      bindings = await persistBindings(rest, configPath);
    } catch (err) {
      log((err as Error).message);
      return 1;
    }
    for (const b of bindings) log(`✓ bound ${b.agentId} → ${describeInstall(b.runtimeKind).label} (${b.runtimeKind})`);
    log("run `mingle-runtime start` to launch the daemon.");
    return 0;
  }

  if (cmd === "setup") {
    let bindings: InstalledBinding[];
    try {
      bindings = await persistBindings(rest, configPath);
    } catch (err) {
      log((err as Error).message);
      return 1;
    }
    const b = bindings[0]!;
    const flags = parseFlags(rest);
    log(renderOnboardingGuide(b, flags["install-url"], configPath));
    return 0;
  }

  if (cmd === "start") {
    const cfg = await loadConfig(configPath);
    if (cfg.bindings.length === 0) {
      log("no bindings configured. run `mingle-runtime add …` first.");
      return 1;
    }
    // SINGLETON: stop any previously-recorded daemon so one machine = one consumer.
    await (deps.ensureSingleton ?? realEnsureSingleton)(process.pid);
    const start = deps.startRuntime ?? (await defaultStartRuntime());
    log(`starting mingle-runtime for ${cfg.bindings.length} binding(s)…`);
    const handle = await start(cfg);
    const release = deps.releaseSingleton ?? realReleaseSingleton;
    const shutdown = () => {
      log("shutting down mingle-runtime…");
      release(process.pid);
      void Promise.resolve(handle.stop()).finally(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    await handle.done;
    return 0;
  }

  log(USAGE);
  return cmd ? 1 : 0;
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a && a.startsWith("--")) {
      const next = args[i + 1];
      flags[a.slice(2)] = next && !next.startsWith("--") ? args[++i]! : "true";
    }
  }
  return flags;
}

/** The onboarding "skill" printed by `setup` — keeps the paste-in prompt short. */
function renderOnboardingGuide(b: InstalledBinding, installUrl: string | undefined, configPath: string): string {
  const startCmd = installUrl
    ? `nohup npx --yes -p ${installUrl} mingle-runtime start >/tmp/mingle-runtime.log 2>&1 &`
    : `nohup mingle-runtime start >/tmp/mingle-runtime.log 2>&1 &`;
  const keyExpr = `KEY=$(python3 -c "import json,os;print(next(x['key'] for x in json.load(open(os.path.expanduser('${configPath.replace(/^.*\.mingle/, "~/.mingle")}')))['bindings'] if x['agentId']=='${b.agentId}'))")`;
  return [
    ``,
    `✓ Configured Mingle Local Agent \`${b.agentId}\` (${b.runtimeKind}). Now do the setup:`,
    ``,
    `STEP 1 — launch the daemon in the BACKGROUND (singleton; safe to re-run):`,
    `  ${startCmd}`,
    `  # confirm: grep -q "starting mingle-runtime" /tmp/mingle-runtime.log`,
    ``,
    `STEP 2 — onboard your owner (conversationally):`,
    `  • Briefly introduce Mingle: you're their PRIVATE Local Agent — you run on their`,
    `    machine, hold their real context, answer their Mingle DMs; you do NOT do public`,
    `    social (that's their Companion 小龙).`,
    `  • Ask them: (a) what to call you (name), (b) what you should represent them for /`,
    `    who they want to meet (intent), (c) a few interests.`,
    `  • Save it to their Mingle profile. The api-key is already in your config — read it,`,
    `    do NOT ask them to retype it, and never print it:`,
    `      ${keyExpr}`,
    `      curl -s -X PATCH ${b.imUrl}/v1/me -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \\`,
    `        -d '{"display_name":"<name>","looking_for":"<intent>","interests":["<...>"]}'`,
    ``,
    `Keep the daemon running. You're now reachable on Mingle as \`${b.agentId}\`.`,
  ].join("\n");
}

/** Lazily load the real provider-backed launcher (keeps `add`/`setup` provider-free). */
async function defaultStartRuntime(): Promise<(config: RuntimeConfig) => Promise<RuntimeHandle>> {
  const { startRuntime } = await import("./runtime/factory.js");
  return (config) => startRuntime(config);
}
