# `mingle-runtime`

The local **Mingle Runtime** daemon: it drives real provider integrations
behind a unified `AgentRuntimeDriver` contract, replacing the old
"常驻连接器 + headless 驱动" model (which shelled out to `claude` / `codex exec`
and scraped stdout). Providers run as persistent, resumable, **per-scope
sessions** — Codex **App Server** (stdio JSON-RPC) and Claude **Agent SDK**
(explicit `session_id` + resume); OpenClaw becomes one adapter.

Design source of truth:
`im/docs/superpowers/specs/2026-07-19-mingle-agent-runtime-platform-design.md`
(§4 protocol, §5 runtime). Workstream plan:
`im/docs/superpowers/plans/2026-07-19-workstream-A-mingle-runtime.md`.

> Independent repo. Does **not** import or modify `openclaw-mingle` or `mingle/`;
> it re-implements the consumer loop + packet shapes it learned from
> `openclaw-mingle/src/connect/*`.

## Status — Increment A1 (protocol + driver contract + registry + consumer)

Shipped in A1 (proven end-to-end with a `FakeDriver`, no real provider yet):

- **Wake Packet** (`src/protocol/wake-packet.ts`) — types + tolerant parser for
  the shared `mingle.agent-wake.v1` schema (forward-compatible; structured
  event/notifications preserved, never restringified). §4.1.
- **Scope keys** (`src/protocol/scope.ts`) — `dm: / channel: / owner: / task:`
  derivation from a wake packet; heartbeat → owner scope. §4.3.
- **Driver contract** (`src/runtime/driver.ts`) — `AgentRuntimeDriver` +
  `RuntimeEvent` union + declared `RuntimeCapabilities` (honest degrade). §5.2.
- **FakeDriver** (`src/runtime/fake-driver.ts`) — scriptable test double.
- **Session Registry** (`src/runtime/session-registry.ts`) — interface +
  in-memory impl mapping `(binding, scope) → provider session`; two-scope and
  two-binding isolation. §5.3. (SQLite persistence + restart-recovery: A2.)
- **Consumer loop** (`src/runtime/consumer.ts`) — long-poll → parse → scope →
  open-or-resume session → run one turn → deliver reply → ACK. §5.1.

## Status — Increment A2 (Codex App Server driver)

Shipped in A2 (spec §5.4 + the two carry-forward requirements):

- **JSON-RPC / stdio** (`src/codex/jsonrpc-stdio.ts`) — JSONL framing, request↔
  response correlation, server notifications, and server-initiated requests
  (Codex asks for approvals this way). Re-entrancy-safe over in-memory peers.
- **Codex client** (`src/codex/client.ts`) — `initialize` → `thread/start` |
  `thread/resume` | `thread/fork` → `turn/start` | `turn/interrupt`; a started
  turn hands back a `completed` promise settled by `turn/completed`.
- **`CodexAppServerDriver`** (`src/codex/driver.ts`) — maps item + turn
  notifications → `RuntimeEvent`; surfaces approvals as `approval.requested` and
  holds the JSON-RPC response open until `approve()` decides (no model
  self-approval); two-scope isolation → two threads.
- **`FakeAppServer`** (`src/codex/fake-app-server.ts`) — in-memory protocol peer
  for the unit tests; scriptable (approval / fail / await-interrupt).
- **SQLite Session Registry** (`src/runtime/sqlite-session-registry.ts`, built-in
  `node:sqlite`) — persistent `(binding, scope) → thread_id`; **restart-recovery**
  test resumes the same Codex thread across a simulated process restart (§5.4).
- **NACK/backoff discipline** (`src/runtime/consumer.ts`) — a transiently-failed
  turn NACKs + stops draining (no ACK-on-failure message loss, the im-server
  P0-3 fix); unparseable packets drop + ACK; cursor advances only on clean drain.
- **Real-binary path** (`src/codex/spawn.ts`) — spawns `codex app-server` over
  stdio; a smoke test runs against it when `codex` is on PATH (else skipped).
  `codex exec` remains diagnostics-only.

## Next

- **A3** — Claude Agent SDK driver (explicit session_id + resume, in-process
  SDK-MCP Mingle tools, `PreToolUse` permissions, honest auth surfacing).
- **A4** — OpenClaw adapter + unified install/UI.

## Dev

```bash
npm install
npm run typecheck
npm test
```
