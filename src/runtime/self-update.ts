/**
 * Platform-controlled auto-update (§ managed runtime updates). On every Event
 * Center poll the daemon reports its version; im-server returns a `runtime.update`
 * directive when a newer version is the configured rollout target. We apply it by
 * RELAUNCHING the daemon via `npx` at the target's versioned (immutable) tarball —
 * the versioned-URL model means the new npx download is exactly the target build.
 * The daemon's config (~/.mingle) persists, so the fresh process resumes every
 * binding. No user reinstall.
 */
import { spawn as nodeSpawn } from "node:child_process";

export type RuntimeUpdateDirective = {
  id: string;
  type: string;
  runtime?: string;
  version?: string;
  install_url?: string;
  required?: boolean;
};

function parseVer(v: string): [number, number, number] | undefined {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v.replace(/^v/, "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}
function cmp(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

/** The first directive that tells us to move to a STRICTLY newer version. */
export function pickRuntimeUpdate(
  directives: RuntimeUpdateDirective[] | undefined,
  currentVersion: string,
): RuntimeUpdateDirective | undefined {
  const cur = parseVer(currentVersion);
  if (!cur || !directives) return undefined;
  for (const d of directives) {
    if (d.type !== "runtime.update" || d.runtime !== "mingle-runtime") continue;
    if (!d.version || !d.install_url) continue;
    const tgt = parseVer(d.version);
    if (tgt && cmp(tgt, cur) > 0) return d;
  }
  return undefined;
}

export type SelfUpdateDeps = {
  spawn?: (cmd: string, args: string[], opts: unknown) => { unref?: () => void };
  exit?: (code: number) => void;
  log?: (msg: string) => void;
};

/** Relaunch at the target version, detached, then exit so the fresh daemon takes
 *  over. (The new consumer may briefly 409 until the old 45s lease expires — fine.) */
export function applySelfUpdate(update: RuntimeUpdateDirective, deps: SelfUpdateDeps = {}): void {
  const log = deps.log ?? ((m: string) => console.log(m));
  log(`[mingle-runtime] auto-update → ${update.version} (${update.install_url}); relaunching…`);
  const spawnImpl =
    deps.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, opts as never));
  const child = spawnImpl(
    "npx",
    ["--yes", "-p", update.install_url!, "mingle-runtime", "start"],
    { detached: true, stdio: "inherit" },
  );
  child.unref?.();
  (deps.exit ?? ((code: number) => process.exit(code)))(0);
}
