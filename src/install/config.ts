/**
 * Install config (spec §9.1) — the persistent binding list the `mingle-runtime`
 * CLI writes on `add` and the daemon reads on `start`. One binding per
 * (agent, runtime); adding a second runtime for the same agent appends, re-adding
 * the same pair updates in place (rotated key / changed dir). Learned from the
 * reference connector's shape (openclaw-mingle/src/connect/config.ts) and
 * re-implemented here — nothing imported.
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ALL_RUNTIME_KINDS } from "./describe.js";
import type { RuntimeKind } from "../runtime/driver.js";

/** One persisted agent binding the runtime drives. */
export type InstalledBinding = {
  agentId: string;
  key: string;
  imUrl: string;
  runtimeKind: RuntimeKind;
  dir?: string;
  model?: string;
  /** Stable Event Center consumer id (single-active-consumer per binding). */
  consumerId: string;
};

export type RuntimeConfig = { bindings: InstalledBinding[] };

/** `~/.mingle/config.json`, overridable via MINGLE_CONFIG_DIR (tests, XDG). */
export function defaultConfigPath(): string {
  return join(process.env.MINGLE_CONFIG_DIR || join(homedir(), ".mingle"), "config.json");
}

/** Expand a leading `~` to the home dir. The install command quotes `--dir '~/x'`,
 *  so the shell never expands it and we receive a literal tilde — an invalid cwd
 *  that breaks the provider (e.g. the Claude SDK can't chdir to it). Resolve it. */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

export async function loadConfig(path = defaultConfigPath()): Promise<RuntimeConfig> {
  try {
    const parsed = JSON.parse(await fs.readFile(path, "utf8")) as RuntimeConfig;
    return { bindings: Array.isArray(parsed.bindings) ? parsed.bindings : [] };
  } catch {
    return { bindings: [] };
  }
}

export async function saveConfig(config: RuntimeConfig, path = defaultConfigPath()): Promise<void> {
  await fs.mkdir(join(path, ".."), { recursive: true });
  // 0o600 — the file holds agent api-keys; keep it owner-only (spec §10).
  await fs.writeFile(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
}

/** Merge a binding in, identified by (agentId, runtimeKind). */
export function upsertBinding(config: RuntimeConfig, binding: InstalledBinding): RuntimeConfig {
  const bindings = config.bindings.filter(
    (b) => !(b.agentId === binding.agentId && b.runtimeKind === binding.runtimeKind),
  );
  bindings.push(binding);
  return { bindings };
}

/** Parse `--flag value` argv into one binding per --runtime. */
export function bindingsFromArgs(args: string[]): InstalledBinding[] {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a && a.startsWith("--")) {
      const next = args[i + 1];
      const val = next && !next.startsWith("--") ? args[++i]! : "true";
      flags[a.slice(2)] = val;
    }
  }
  const agentId = flags.agent ?? "";
  const key = flags.key ?? "";
  const imUrl = flags["im-url"] ?? flags.imUrl ?? "";
  if (!agentId || !key || !imUrl) {
    throw new Error("add requires --agent <id> --key <key> --im-url <url> --runtime <name[,name]>");
  }
  const runtimes = (flags.runtime ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (runtimes.length === 0) {
    throw new Error("add requires --runtime <codex|claude-code|openclaw>[,…]");
  }
  for (const r of runtimes) {
    if (!ALL_RUNTIME_KINDS.includes(r as RuntimeKind)) throw new Error(`unknown runtime: ${r}`);
  }
  return runtimes.map((runtime) => ({
    agentId,
    key,
    imUrl,
    runtimeKind: runtime as RuntimeKind,
    ...(flags.dir ? { dir: expandHome(flags.dir) } : {}),
    ...(flags.model ? { model: flags.model } : {}),
    consumerId: `mingle-runtime-${agentId}-${runtime}`,
  }));
}
