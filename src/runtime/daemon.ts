/**
 * Daemon (spec §5.1) — the long-running side of `mingle-runtime start`. For each
 * installed binding it loops the consumer's single-drain (`runBindingOnce`),
 * threading the Event Center cursor and backing off on a thrown error, until
 * stopped. Bindings run concurrently and are isolated (their own driver, session
 * registry entry, and http client). The provider/im wiring is INJECTED via `make`
 * so this orchestration is tested with fakes and no network/process spawn.
 */
import { runBindingOnce, runDigestOnce, type Binding, type EventCenterClient } from "./consumer.js";
import type { AgentRuntimeDriver } from "./driver.js";
import type { SessionRegistry } from "./session-registry.js";
import type { InstalledBinding } from "../install/config.js";

/** Map a persisted install binding onto the consumer's runtime Binding. The
 *  owner-scope key falls back to the agent id — it is only a stable scope key for
 *  heartbeat/ambient turns and is never persisted into im-server. */
export function toBinding(b: InstalledBinding): Binding {
  return {
    bindingId: `${b.agentId}:${b.runtimeKind}`,
    agentAccountId: b.agentId,
    ownerAccountId: b.agentId,
    runtimeKind: b.runtimeKind,
  };
}

const DEFAULT_WAIT = 25000;
const DEFAULT_BACKOFF = 2000;
const DEFAULT_DIGEST = 300000; // 5 min — periodic notification-only wake (0 disables)
const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Yield to the macrotask queue between polls. Backpressure normally comes from the
 *  long-poll `wait`, but a low/zero `wait` (or an immediately-returning Event Center)
 *  would otherwise busy-spin on microtasks and starve timers/other loops. */
const macrotaskYield = () => new Promise<void>((r) => setTimeout(r, 0));

export type BindingLoop = {
  binding: Binding;
  driver: AgentRuntimeDriver;
  registry: SessionRegistry;
  imClient: EventCenterClient;
  wait?: number;
  backoffMs?: number;
  /** How often to run a digest heartbeat (notification-only wake). 0 disables. */
  digestMs?: number;
  shouldStop: () => boolean;
  onError?: (err: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock (tests). */
  now?: () => number;
};

export async function runBindingLoop(loop: BindingLoop): Promise<void> {
  const wait = loop.wait ?? DEFAULT_WAIT;
  const backoffMs = loop.backoffMs ?? DEFAULT_BACKOFF;
  const digestMs = loop.digestMs ?? DEFAULT_DIGEST;
  const sleep = loop.sleep ?? realSleep;
  const now = loop.now ?? Date.now;
  let cursor: string | undefined;
  let lastDigestAt = now();
  while (!loop.shouldStop()) {
    try {
      cursor = await runBindingOnce({
        binding: loop.binding,
        driver: loop.driver,
        registry: loop.registry,
        imClient: loop.imClient,
        cursor,
        wait,
      });
      // Serialized with the drain (same loop, same consumer) — no concurrent polls,
      // no cursor race. A heartbeat turn fires only when notifications are pending.
      if (digestMs > 0 && now() - lastDigestAt >= digestMs) {
        lastDigestAt = now();
        await runDigestOnce({
          binding: loop.binding,
          driver: loop.driver,
          registry: loop.registry,
          imClient: loop.imClient,
        });
      }
    } catch (err) {
      loop.onError?.(err);
      await sleep(backoffMs);
    }
    await macrotaskYield();
  }
}

/** The per-binding provider + im wiring the daemon drives. */
export type BindingRuntime = {
  driver: AgentRuntimeDriver;
  registry: SessionRegistry;
  imClient: EventCenterClient;
};

export type DaemonHandle = { stop: () => Promise<void>; done: Promise<void[]> };

export function startDaemon(input: {
  bindings: Binding[];
  make: (binding: Binding) => BindingRuntime;
  wait?: number;
  backoffMs?: number;
  digestMs?: number;
  onError?: (binding: Binding, err: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}): DaemonHandle {
  let stopped = false;
  const shouldStop = () => stopped;
  const loops = input.bindings.map((binding) => {
    const rt = input.make(binding);
    return runBindingLoop({
      binding,
      driver: rt.driver,
      registry: rt.registry,
      imClient: rt.imClient,
      ...(input.wait !== undefined ? { wait: input.wait } : {}),
      ...(input.backoffMs !== undefined ? { backoffMs: input.backoffMs } : {}),
      ...(input.digestMs !== undefined ? { digestMs: input.digestMs } : {}),
      ...(input.sleep ? { sleep: input.sleep } : {}),
      shouldStop,
      onError: (e) => input.onError?.(binding, e),
    });
  });
  const done = Promise.all(loops);
  return {
    done,
    stop: async () => {
      stopped = true;
      await done;
    },
  };
}
