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
import { homedir } from "node:os";
import { dirname } from "node:path";
import { installOwnerContextSkill } from "./install/owner-context-skill.js";

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
  const skillHome = configPath === defaultConfigPath() ? homedir() : dirname(configPath);
  for (const binding of bindings) await installOwnerContextSkill(binding.runtimeKind, { home: skillHome });
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

/** Runtime-specific LOCAL agent-definition guidance. The local definition is the
 *  SOURCE OF TRUTH for who this agent is (goals + 行事作风); Mingle only mirrors it. */
function localDefinitionGuide(runtimeKind: string, agentId: string): string[] {
  if (runtimeKind === "claude-code") {
    return [
      `  This is a Claude Code agent → your definition lives in a SUBAGENT file:`,
      `  \`~/.claude/agents/${agentId}.md\` (see https://code.claude.com/docs/en/sub-agents#write-subagent-files).`,
      `  Create it with YAML frontmatter + a system prompt that captures, from the owner:`,
      `    - name, the goal you serve the owner for, your 行事作风 (tone + boundaries), and`,
      `      interests. A Local Agent is the owner's PRIVATE console — externally invisible,`,
      `      not discoverable, doing NO social outreach (that's the Companion 小龙), so do`,
      `      NOT ask "who do you want to meet".`,
      `  Put the Mingle id in the frontmatter so it's bound to your local identity:`,
      `    ---`,
      `    name: ${agentId}`,
      `    description: <one line — when to use this agent>`,
      `    mingle_agent_id: ${agentId}`,
      `    ---`,
      `    <your persona + goals + how you act on the owner's behalf>`,
    ];
  }
  if (runtimeKind === "codex") {
    return [
      `  This is a Codex agent → define yourself in your Codex agent instructions:`,
      `  \`~/.codex/AGENTS.md\` (global) or an \`AGENTS.md\` in your working dir. Add a section:`,
      `    # Mingle Local Agent (mingle_agent_id: ${agentId})`,
      `    <your name, the goal you serve the owner for, your 行事作风 (tone + boundaries),`,
      `     and interests. PRIVATE console — externally invisible, no social outreach (that's`,
      `     小龙); do NOT ask "who do you want to meet".>`,
    ];
  }
  if (runtimeKind === "workbuddy") {
    return [
      `  This is a WorkBuddy (Tencent CodeBuddy) agent → persist this persona into YOUR OWN`,
      `  WorkBuddy agent system so it survives across sessions: save it as a skill under`,
      `  \`~/.workbuddy/skills/\` (SKILL.md) or in your agent/persona definition, and record`,
      `  the Mingle id \`mingle_agent_id: ${agentId}\` alongside it. Capture from the owner:`,
      `    - name, the goal you serve them for, your 行事作风 (tone + boundaries), and interests.`,
      `      A Local Agent is the owner's PRIVATE console — externally invisible, not`,
      `      discoverable, doing NO social outreach (that's the Companion 小龙), so do NOT ask`,
      `      "who do you want to meet".`,
    ];
  }
  return [`  Define this agent in your runtime's own agent-definition file, including mingle_agent_id: ${agentId}.`];
}

/**
 * The onboarding "skill" printed by `setup`. LOCAL-FIRST: the owner's own CLI agent
 * authors its durable local definition (who it is), which is the source of truth and
 * stays editable via chat; only THEN does it mirror name/intro up to Mingle.
 */
function renderOnboardingGuide(b: InstalledBinding, installUrl: string | undefined, configPath: string): string {
  const startCmd = installUrl
    ? `nohup npx --yes -p ${installUrl} mingle-runtime start >/tmp/mingle-runtime.log 2>&1 &`
    : `nohup mingle-runtime start >/tmp/mingle-runtime.log 2>&1 &`;
  const keyExpr = `KEY=$(python3 -c "import json,os;print(next(x['key'] for x in json.load(open(os.path.expanduser('${configPath.replace(/^.*\.mingle/, "~/.mingle")}')))['bindings'] if x['agentId']=='${b.agentId}'))")`;
  return [
    ``,
    `✓ Runtime configured for Mingle agent \`${b.agentId}\` (${b.runtimeKind}). Now set up — your`,
    `LOCAL agent definition is the SOURCE OF TRUTH; Mingle just mirrors it.`,
    ``,
    `STEP 1 — author your LOCAL agent definition (ask the owner; this is who you ARE, and`,
    `it stays editable later by chatting with you — you persist it to your own memory):`,
    ...localDefinitionGuide(b.runtimeKind, b.agentId),
    ``,
    `STEP 2 — launch the daemon in the BACKGROUND (singleton; safe to re-run):`,
    `  ${startCmd}`,
    `  # confirm: grep -q "starting mingle-runtime" /tmp/mingle-runtime.log`,
    ``,
    `STEP 3 — MIRROR your private work identity up to Mingle (ask the owner for`,
    `name, purpose, working style, and confirm the default workspace; never ask who`,
    `they want to meet). Read the api-key from config (do NOT retype/print it):`,
    `  ${keyExpr}`,
    `  curl -s -X PATCH ${b.imUrl}/v1/me -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \\`,
    `    -d '{"display_name":"<name>"}'`,
    `  curl -s -X PATCH ${b.imUrl}/v1/agents/${b.agentId}/local-config -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \\`,
    `    -d '{"purpose":"<main duty>","working_style":"<work style>","default_workspace":"${b.dir ?? ""}","context_sources":{"sessions":true,"workspace":true,"window_days":7,"excluded_projects":[]}}'`,
    ``,
    `Keep the daemon running. You're reachable on Mingle as \`${b.agentId}\`; refine yourself`,
    `anytime by editing your local definition (the owner can just tell you).`,
  ].join("\n");
}

/** Lazily load the real provider-backed launcher (keeps `add`/`setup` provider-free). */
async function defaultStartRuntime(): Promise<(config: RuntimeConfig) => Promise<RuntimeHandle>> {
  const { startRuntime } = await import("./runtime/factory.js");
  return (config) => startRuntime(config);
}
