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

## Next

- **A2** — Codex App Server driver (stdio JSON-RPC, thread start/resume/fork,
  turn start/steer/interrupt, resume-on-crash) + SQLite registry persistence.
- **A3** — Claude Agent SDK driver (explicit session_id + resume, in-process
  SDK-MCP Mingle tools, `PreToolUse` permissions, honest auth surfacing).
- **A4** — OpenClaw adapter + unified install/UI.

## Dev

```bash
npm install
npm run typecheck
npm test
```
