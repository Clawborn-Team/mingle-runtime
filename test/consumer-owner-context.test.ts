import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { processWake, runBindingOnce, type EventCenterClient, type UpdatesResult, type Binding } from "../src/runtime/consumer.js";
import { InMemorySessionRegistry } from "../src/runtime/session-registry.js";
import { FakeDriver } from "../src/runtime/fake-driver.js";
import { buildWakePacket } from "../src/protocol/wake-adapter.js";
import { prepareOwnerContextRefresh } from "../src/owner-context/runner.js";
import type { SessionSource } from "../src/owner-context/types.js";
import { dmRawEvent, ownerContextRefreshRawEvent, ownerContextPortraitRawEvent } from "./fixtures/wake-packets.js";

/** A fully-formed, valid owner-context-v1 recent-briefing report. */
function validBriefing(materialChange = true): string {
  return JSON.stringify({
    schema_version: "owner-context-v1",
    mode: "recent-briefing",
    window: { days: 7, from: "2026-07-14T00:00:00.000Z", to: "2026-07-21T00:00:00.000Z" },
    source_summary: { runtime: "codex", session_count: 1, project_count: 1 },
    recent_activity: [{ topic: "t", summary: "s", status: "in_progress", last_seen_at: "2026-07-21T00:00:00.000Z", confidence: "high" }],
    decisions: [],
    open_threads: [],
    current_concerns: [],
    questions_companion_may_ask: [],
    material_change: materialChange,
  });
}

function validPortrait(): string {
  return JSON.stringify({
    schema_version: "owner-context-v1",
    mode: "owner-portrait",
    portrait_signals: [{ dimension: "builder", observation: "ships infra", confidence: "high", evidence_count: 3, observed_across_projects: 2 }],
    contradictions: [],
    insufficient_evidence: [],
  });
}

type FakeIm = EventCenterClient & { commits: number; dms: unknown[] };
function fakeIm(overrides: Partial<EventCenterClient> = {}): FakeIm {
  const dms: unknown[] = [];
  const state = { commits: 0 };
  const base: FakeIm = {
    dms,
    get commits() {
      return state.commits;
    },
    async getUpdates() {
      return { events: [] };
    },
    async ack() {},
    async nack() {},
    async sendDm(to: string, body: string) {
      dms.push({ to, body });
      return { ok: true, status: 201 };
    },
    async postToChannel() {
      return { ok: true, status: 201 };
    },
    async commitOwnerContext() {
      state.commits += 1;
    },
  } as FakeIm;
  Object.assign(base, overrides);
  return base;
}

const binding: Binding = { bindingId: "b1", agentAccountId: "a1", ownerAccountId: "owner1", runtimeKind: "codex" };

/** A drain-path Event Center fake that records ACK / NACK / commit so the promised
 *  "ACK-without-NACK on delivered-but-invalid; NACK-without-commit on turn.failed"
 *  contract is asserted through the REAL drain path (runBindingOnce), not just
 *  processWake (whose no-op ack/nack record nothing). */
type DrainFake = EventCenterClient & {
  acked: string[];
  nacked: { id: string; reason: string }[];
  commits: number;
  dms: { to: string; body: string }[];
};
function drainFake(batch: UpdatesResult): DrainFake {
  const queue = [batch];
  const state = { commits: 0 };
  const im: DrainFake = {
    acked: [],
    nacked: [],
    dms: [],
    get commits() {
      return state.commits;
    },
    async getUpdates() {
      return queue.shift() ?? { events: [] };
    },
    async ack(ids) {
      im.acked.push(...ids);
    },
    async nack(id, reason) {
      im.nacked.push({ id, reason });
    },
    async sendDm(to, body) {
      im.dms.push({ to, body });
      return { ok: true, status: 201 };
    },
    async postToChannel() {
      return { ok: true, status: 201 };
    },
    async commitOwnerContext() {
      state.commits += 1;
    },
  } as DrainFake;
  return im;
}

describe("owner-context commit fires only on a VALID delivered refresh", () => {
  it("commits + delivers when a valid recent-briefing report is delivered", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ reply: validBriefing() });
    const im = fakeIm();
    const packet = buildWakePacket({ account_id: "a1", agent_kind: "local" }, { kind: "event", event: ownerContextRefreshRawEvent }, [], "t");

    const result = await processWake({ packet, binding, driver, registry, imClient: im });

    expect(result.delivery).toBe("delivered");
    expect(im.commits).toBe(1);
  });

  it("commits when a valid owner-portrait report is delivered for an owner-portrait wake", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ reply: validPortrait() });
    const im = fakeIm();
    const packet = buildWakePacket({ account_id: "a1", agent_kind: "local" }, { kind: "event", event: ownerContextPortraitRawEvent }, [], "t");

    const result = await processWake({ packet, binding, driver, registry, imClient: im });

    expect(result.delivery).toBe("delivered");
    expect(im.commits).toBe(1);
  });

  it("does NOT commit when the owner-context turn produced no deliverable report", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ reply: "" }); // no final report → nothing delivered
    const im = fakeIm();
    const packet = buildWakePacket({ account_id: "a1", agent_kind: "local" }, { kind: "event", event: ownerContextRefreshRawEvent }, [], "t");

    await processWake({ packet, binding, driver, registry, imClient: im });

    expect(im.commits).toBe(0);
  });

  it("delivers but does NOT commit when the report is malformed (provider apology / truncated JSON)", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ reply: "Sorry, I couldn't produce that report." });
    const im = fakeIm();
    const packet = buildWakePacket({ account_id: "a1", agent_kind: "local" }, { kind: "event", event: ownerContextRefreshRawEvent }, [], "t");

    const result = await processWake({ packet, binding, driver, registry, imClient: im });

    // The DM was still delivered → the caller ACKs (no NACK/double-send). But the
    // window is NOT consumed, so the next refresh can re-distill it.
    expect(result.delivery).toBe("delivered");
    expect(im.commits).toBe(0);
  });

  it("delivers but does NOT commit when a wrong-mode report is returned (portrait wake, briefing report)", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ reply: validBriefing() }); // briefing, but wake asked for portrait
    const im = fakeIm();
    const packet = buildWakePacket({ account_id: "a1", agent_kind: "local" }, { kind: "event", event: ownerContextPortraitRawEvent }, [], "t");

    const result = await processWake({ packet, binding, driver, registry, imClient: im });

    expect(result.delivery).toBe("delivered");
    expect(im.commits).toBe(0);
  });

  it("does NOT commit for an ordinary (non owner-context) delivered DM", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ reply: "hi there" });
    const im = fakeIm();
    const packet = buildWakePacket({ account_id: "a1", agent_kind: "local" }, { kind: "event", event: dmRawEvent }, [], "t");

    const result = await processWake({ packet, binding, driver, registry, imClient: im });

    expect(result.delivery).toBe("delivered");
    expect(im.commits).toBe(0);
  });
});

describe("owner-context ACK/NACK contract through the REAL drain path (P1-4)", () => {
  it("a VALID delivered briefing → ACK, no NACK, and the window is committed", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ reply: validBriefing() });
    const im = drainFake({ events: [ownerContextRefreshRawEvent] });

    await runBindingOnce({ binding, driver, registry, imClient: im });

    expect(im.acked).toEqual(["e_owner_ctx"]);
    expect(im.nacked).toEqual([]);
    expect(im.commits).toBe(1);
  });

  it("a MALFORMED delivered report (apology) → ACK, NOT NACK, and does NOT commit", async () => {
    // The DM was delivered, so the wake is ACKed (no NACK → no double-send). But the
    // body is invalid, so the window stays open (commits=0). This is the contract the
    // direct-processWake test could not observe (its fake ack/nack recorded nothing).
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ reply: "Sorry, I couldn't produce that report." });
    const im = drainFake({ events: [ownerContextRefreshRawEvent] });

    await runBindingOnce({ binding, driver, registry, imClient: im });

    expect(im.acked).toEqual(["e_owner_ctx"]);
    expect(im.nacked).toEqual([]);
    expect(im.commits).toBe(0);
  });

  it("a WRONG-MODE delivered report (portrait wake, briefing body) → ACK, NOT NACK, no commit", async () => {
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ reply: validBriefing() }); // briefing, but wake asked for portrait
    const im = drainFake({ events: [ownerContextPortraitRawEvent] });

    await runBindingOnce({ binding, driver, registry, imClient: im });

    expect(im.acked).toEqual(["e_owner_portrait"]);
    expect(im.nacked).toEqual([]);
    expect(im.commits).toBe(0);
  });

  it("a turn.failed owner-context turn → NACK, NOT ACK, and does NOT commit", async () => {
    // A transiently-failed owner-context turn must NACK for backoff (no window consumed,
    // no ACK past the gap) — the failed-turn branch of the commit gate + drain discipline.
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ script: "approval-then-fail" }); // emits turn.failed
    const im = drainFake({ events: [ownerContextRefreshRawEvent] });

    await runBindingOnce({ binding, driver, registry, imClient: im });

    expect(im.nacked.map((n) => n.id)).toEqual(["e_owner_ctx"]);
    expect(im.acked).toEqual([]);
    expect(im.commits).toBe(0);
  });

  it("a FAILED delivery (sendDm not ok) → NACK, NOT ACK, and does NOT commit", async () => {
    // A valid report that fails to SEND must NACK (redeliver) and never commit the window
    // — the delivered-guard means "actually reached the Companion", not "was attempted".
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ reply: validBriefing() });
    const im = drainFake({ events: [ownerContextRefreshRawEvent] });
    im.sendDm = async () => ({ ok: false, status: 403 });

    await runBindingOnce({ binding, driver, registry, imClient: im });

    expect(im.nacked.map((n) => n.id)).toEqual(["e_owner_ctx"]);
    expect(im.acked).toEqual([]);
    expect(im.commits).toBe(0);
  });

  it("a no-reply owner-context turn → ACK (nothing to deliver), NOT NACK, no commit", async () => {
    // Retain the existing no-reply no-commit coverage, now through the drain path: no
    // final report → delivery is "none" → nothing to route → ACK, no NACK, no commit.
    const registry = new InMemorySessionRegistry();
    const driver = new FakeDriver({ reply: "" });
    const im = drainFake({ events: [ownerContextRefreshRawEvent] });

    await runBindingOnce({ binding, driver, registry, imClient: im });

    expect(im.acked).toEqual(["e_owner_ctx"]);
    expect(im.nacked).toEqual([]);
    expect(im.commits).toBe(0);
  });
});

describe("a delivered-but-invalid refresh leaves the window OPEN for the next refresh", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mingle-oc-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a subsequent prepareOwnerContextRefresh over the same window still reports material_change=true", async () => {
    const statePath = join(dir, "state.json");
    const source = async (): Promise<SessionSource[]> => [
      { provider: "codex", sessionId: "s1", project: "p", updatedAt: "2026-07-21", messages: [{ role: "user", text: "decide the pricing tier" }] },
    ];

    // First refresh: material change detected, but the model returned garbage → NOT committed.
    const first = await prepareOwnerContextRefresh({ runtime: "codex", mode: "recent-briefing", days: 7, statePath, source });
    expect(first.materialChange).toBe(true);
    // (No commit() call — this simulates the delivered-but-invalid consumer path.)

    // Second refresh over the SAME unchanged window: because the window was never
    // committed, it must STILL be material (re-distill), not a canned no-change report.
    const second = await prepareOwnerContextRefresh({ runtime: "codex", mode: "recent-briefing", days: 7, statePath, source });
    expect(second.materialChange).toBe(true);
  });
});
