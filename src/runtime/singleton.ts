/**
 * Daemon singleton (one Event Center consumer per machine). Onboarding a SECOND
 * runtime (e.g. codex after claude-code) re-runs `mingle-runtime start`; without
 * this that would leave TWO daemons fighting over the per-account lease (409). A
 * PID lock in ~/.mingle lets a new `start` stop the previously-recorded daemon and
 * take over — so the fresh process (which reads the updated config with BOTH
 * bindings) is the only one running. Also covers the self-update relaunch.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from "node:fs";

function configDir(): string {
  return process.env.MINGLE_CONFIG_DIR || join(homedir(), ".mingle");
}
export function lockPath(): string {
  return join(configDir(), "daemon.pid");
}

function realReadLock(): number | undefined {
  try {
    const n = Number(readFileSync(lockPath(), "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}
function realWriteLock(pid: number): void {
  const dir = configDir();
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* exists */
  }
  writeFileSync(lockPath(), String(pid), { mode: 0o600 });
}
function realClearLock(): void {
  try {
    if (existsSync(lockPath())) unlinkSync(lockPath());
  } catch {
    /* best effort */
  }
}

export type SingletonDeps = {
  isAlive?: (pid: number) => boolean;
  kill?: (pid: number, signal: string) => void;
  readLock?: () => number | undefined;
  writeLock?: (pid: number) => void;
  clearLock?: () => void;
  sleep?: (ms: number) => Promise<void>;
  log?: (m: string) => void;
};

/** Stop any previously-recorded daemon, then claim the lock for this process. */
export async function ensureSingleton(myPid: number, deps: SingletonDeps = {}): Promise<void> {
  const isAlive =
    deps.isAlive ??
    ((pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
  const kill =
    deps.kill ??
    ((pid: number, sig: string) => {
      try {
        process.kill(pid, sig as NodeJS.Signals);
      } catch {
        /* already gone */
      }
    });
  const readLock = deps.readLock ?? realReadLock;
  const writeLock = deps.writeLock ?? realWriteLock;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = deps.log ?? ((m: string) => console.log(m));

  const existing = readLock();
  if (existing && existing !== myPid && isAlive(existing)) {
    log(`[mingle-runtime] another daemon (pid ${existing}) is already running — stopping it (single consumer per machine).`);
    kill(existing, "SIGTERM");
    for (let i = 0; i < 20 && isAlive(existing); i++) await sleep(150);
    if (isAlive(existing)) kill(existing, "SIGKILL");
  }
  writeLock(myPid);
}

/** Clear the lock on shutdown — but only if a successor hasn't already claimed it. */
export function releaseSingleton(myPid: number, deps: SingletonDeps = {}): void {
  const readLock = deps.readLock ?? realReadLock;
  const clearLock = deps.clearLock ?? realClearLock;
  if (readLock() === myPid) clearLock();
}
