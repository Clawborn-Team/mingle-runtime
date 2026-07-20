import { describe, it, expect } from "vitest";
import { ensureSingleton, releaseSingleton, type SingletonDeps } from "../src/runtime/singleton.js";

function harness(initialLock?: number, aliveSet: number[] = []) {
  let lock = initialLock;
  const alive = new Set(aliveSet);
  const killed: { pid: number; sig: string }[] = [];
  const deps: SingletonDeps = {
    isAlive: (pid) => alive.has(pid),
    kill: (pid, sig) => {
      killed.push({ pid, sig });
      if (sig === "SIGKILL") alive.delete(pid);
      if (sig === "SIGTERM") alive.delete(pid); // model a well-behaved daemon that exits on SIGTERM
    },
    readLock: () => lock,
    writeLock: (pid) => (lock = pid),
    clearLock: () => (lock = undefined),
    sleep: async () => {},
    log: () => {},
  };
  return { deps, killed, getLock: () => lock };
}

describe("daemon singleton", () => {
  it("stops a previously-recorded alive daemon and claims the lock", async () => {
    const h = harness(111, [111]);
    await ensureSingleton(222, h.deps);
    expect(h.killed[0]).toEqual({ pid: 111, sig: "SIGTERM" });
    expect(h.getLock()).toBe(222); // we now own the lock
  });

  it("does nothing to a stale lock whose process is gone — just claims it", async () => {
    const h = harness(111, []); // 111 not alive
    await ensureSingleton(222, h.deps);
    expect(h.killed).toEqual([]);
    expect(h.getLock()).toBe(222);
  });

  it("does not kill itself if the lock already holds our pid", async () => {
    const h = harness(222, [222]);
    await ensureSingleton(222, h.deps);
    expect(h.killed).toEqual([]);
    expect(h.getLock()).toBe(222);
  });

  it("SIGKILLs a daemon that ignores SIGTERM", async () => {
    const stubborn = harness(111, [111]);
    stubborn.deps.kill = (pid, sig) => {
      // only SIGKILL removes it; SIGTERM is ignored
      // (record via closure)
    };
    // simpler: model stubbornness inline
    const alive = new Set([111]);
    const killed: { pid: number; sig: string }[] = [];
    const deps: SingletonDeps = {
      isAlive: (p) => alive.has(p),
      kill: (p, s) => { killed.push({ pid: p, sig: s }); if (s === "SIGKILL") alive.delete(p); },
      readLock: () => 111, writeLock: () => {}, clearLock: () => {}, sleep: async () => {}, log: () => {},
    };
    await ensureSingleton(222, deps);
    expect(killed.map((k) => k.sig)).toContain("SIGTERM");
    expect(killed.map((k) => k.sig)).toContain("SIGKILL");
  });

  it("releaseSingleton clears the lock only if we still own it", () => {
    const h = harness(222);
    releaseSingleton(222, h.deps);
    expect(h.getLock()).toBeUndefined();
    const h2 = harness(999); // someone else owns it (e.g. a self-update successor)
    releaseSingleton(222, h2.deps);
    expect(h2.getLock()).toBe(999); // not cleared
  });
});
