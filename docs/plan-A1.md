# Increment A1 — protocol + driver contract + registry + consumer loop + FakeDriver

> Part of Workstream A (`docs/superpowers/plans/2026-07-19-workstream-A-mingle-runtime.md`).
> Spec: `im/docs/superpowers/specs/2026-07-19-mingle-agent-runtime-platform-design.md` §4, §5.2, §5.3, §13.1.
> Skill workflow: spec IS the approved design → this plan → executing-plans with **TDD**.

## Goal

Stand up the `mingle-runtime` skeleton and prove the wake→scope→driver→turn path
**end-to-end with a FakeDriver**, over the shared Wake-Packet schema. No real
provider yet (Codex App Server = A2, Claude Agent SDK = A3).

## Scope (A1 only)

1. Repo scaffold (TS + vitest, ESM, strict) — no provider deps.
2. **Wake Packet types + parser** (`mingle.agent-wake.v1`) — mirror the shared
   schema from `im-server/src/agent-protocol/wake-packet.ts`; forward-compatible
   (unknown fields tolerated, event/notification/reply-target NOT restringified).
3. **`scope_key` derivation** (§4.3): `dm:<peer>` / `channel:<id>` / `owner:<id>`
   / `task:<id>` from a wake packet's `conversation`.
4. **`AgentRuntimeDriver` contract + `RuntimeEvent` union** (§5.2) with declared
   `RuntimeCapabilities` (honest degrade, §9.2).
5. **Session Registry** (§5.3) — interface + in-memory impl mapping
   `binding_id + scope_key ↔ provider_session_id` (+ status fields). SQLite-backed
   persistence is deferred to when restart-recovery is exercised (A2).
6. **Consumer loop** — long-poll an Event Center client, compute scope_key,
   open-or-resume a session via the registry, dispatch one turn through the
   driver, collect the streamed `RuntimeEvent`s, ACK. Injectable im-client +
   driver so it runs against a Fake with no network.
7. **FakeDriver** (test double) implementing the full contract, streaming a
   canonical event sequence.

## Out of scope (later increments)

- Real Codex/Claude/OpenClaw drivers (A2/A3/A4).
- OS keychain secret storage (wired when a real credential exists — A2+).
- SQLite persistence + restart-recovery test (A2, where a real thread_id exists).
- Mingle Actions beyond the reply/ACK the loop needs.

## TDD steps

Each: write failing test → run (red) → implement → run (green) → commit.

- [ ] **S1 scaffold** — package.json, tsconfig, vitest.config, .gitignore, src/ + test/ dirs. Commit.
- [ ] **S2 wake packet** — `test/wake-packet.test.ts`: the shared fixture parses;
      schema===`mingle.agent-wake.v1`; unknown top-level field tolerated; a
      malformed packet (wrong schema) rejected. Implement `src/protocol/wake-packet.ts`.
- [ ] **S3 scope key** — `test/scope.test.ts`: dm/channel/owner/task packets →
      right `scope_key`; a packet with no `conversation` (heartbeat) → the
      binding's `owner:` scope fallback. Implement `src/protocol/scope.ts`.
- [ ] **S4 driver contract + RuntimeEvent** — `test/runtime-event.test.ts`: the
      `RuntimeEvent` union type-checks each variant; a driver's capabilities are
      declared. Implement `src/runtime/driver.ts` (types only). Add `FakeDriver`
      in `src/runtime/fake-driver.ts` + `test/fake-driver.test.ts`: `runTurn`
      streams `turn.started → assistant.delta → turn.completed`; `approve` /
      `interrupt` observable.
- [ ] **S5 session registry** — `test/session-registry.test.ts`: open creates a
      mapping; second lookup for the same (binding, scope) returns the same ref;
      two scopes isolated; two bindings isolated. Implement
      `src/runtime/session-registry.ts` (interface + `InMemorySessionRegistry`).
- [ ] **S6 consumer loop** — `test/consumer.test.ts`: with a fake im-client
      yielding one dm wake + a FakeDriver, one iteration computes `dm:<peer>`,
      opens a session, runs a turn, ACKs the event; a same-scope second wake
      RESUMES (no new session). Implement `src/runtime/consumer.ts`.
- [ ] **S7 green gate** — `npm run typecheck` + `npx vitest run` all green; README
      stub describing the A1 surface. Commit. Hand back for review.

## Contract sketch (from §5.2, refined for A1)

```ts
type RuntimeEvent =
  | { type: "turn.started"; turnId: string }
  | { type: "assistant.delta"; turnId: string; text: string }
  | { type: "tool.started"; turnId: string; toolId: string; name: string }
  | { type: "tool.completed"; turnId: string; toolId: string; ok: boolean }
  | { type: "approval.requested"; turnId: string; approvalId: string; detail: string }
  | { type: "file.changed"; turnId: string; path: string }
  | { type: "turn.completed"; turnId: string; text?: string }
  | { type: "turn.failed"; turnId: string; error: string };

interface AgentRuntimeDriver {
  readonly kind: "openclaw" | "claude-code" | "codex";
  readonly capabilities: RuntimeCapabilities; // honest degrade (§9.2)
  probe(): Promise<RuntimeProbe>;
  openSession(input: OpenSessionInput): Promise<ProviderSession>;
  resumeSession(ref: ProviderSessionRef): Promise<ProviderSession>;
  runTurn(input: RunTurnInput): AsyncIterable<RuntimeEvent>;
  approve(input: ApprovalDecision): Promise<void>;
  interrupt(turnId: string): Promise<void>;
  closeSession(ref: ProviderSessionRef): Promise<void>;
  shutdown(): Promise<void>;
}
```
