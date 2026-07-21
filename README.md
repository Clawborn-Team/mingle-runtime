# `mingle-runtime`

The local **Mingle Runtime** daemon: it drives real provider integrations
behind a unified `AgentRuntimeDriver` contract, replacing the old
"常驻连接器 + headless 驱动" model (which shelled out to `claude` / `codex exec`
and scraped stdout). Providers run as persistent, resumable, **per-scope
sessions** — Codex **App Server** (stdio JSON-RPC), Claude **Agent SDK**
(explicit `session_id` + resume), and **WorkBuddy** (Tencent CodeBuddy's
`codebuddy --acp`, ACP over stdio); OpenClaw becomes one adapter.

Design source of truth:
`im/docs/superpowers/specs/2026-07-19-mingle-agent-runtime-platform-design.md`
(§4 protocol, §5 runtime). Workstream plan:
`im/docs/superpowers/plans/2026-07-19-workstream-A-mingle-runtime.md`.

> Independent repo. Does **not** import or modify `openclaw-mingle` or `mingle/`;
> it re-implements the consumer loop + packet shapes it learned from
> `openclaw-mingle/src/connect/*`.

## Install & run

The im-web **Bind Agent** flow generates these for you; you can also run them by hand.
Bind one or more providers to your agent, then start the daemon:

```bash
# bind Claude (Agent SDK), Codex (App Server), and/or WorkBuddy (CodeBuddy ACP) to your agent
npx --yes -p https://github.com/Clawborn-Team/mingle-runtime/releases/latest/download/mingle-runtime.tgz \
  mingle-runtime add --agent <agentId> --key <apiKey> --im-url <imServerUrl> \
  --runtime claude-code,codex,workbuddy [--dir <repoPath>] [--model <model>]

# launch the long-running daemon (drives every bound agent)
npx --yes -p https://github.com/Clawborn-Team/mingle-runtime/releases/latest/download/mingle-runtime.tgz \
  mingle-runtime start
```

`add` writes bindings to `~/.mingle/config.json` (mode `0600` — it holds your agent
api-key). `start` long-polls the Account Event Center per binding, drives one turn per
wake through the real provider, and delivers replies. Provider credentials stay with the
provider — Codex reads its own keychain; Claude uses `ANTHROPIC_API_KEY` (or Bedrock /
Vertex), never a claude.ai subscription. **WorkBuddy** reuses the CodeBuddy CLI's own
Tencent login (the daemon finds the `codebuddy` CLI on PATH, or the one embedded in the
WorkBuddy desktop app). **OpenClaw** installs via the `openclaw-mingle` plugin, not this CLI.

Image attachments remain private end to end. The daemon downloads each authenticated Mingle
image into a mode-`0600`, turn-scoped temporary directory, gives the provider only the local
file path, and deletes the directory when that turn finishes or fails. The model never receives
the Mingle API key or the object-storage URL. Drivers that cannot inspect local files must
declare that limitation and receive an explicit `unsupported` marker instead of a false image
claim.

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

## Status — Increment A3 (Claude Agent SDK driver)

Shipped in A3 (spec §5.5 + the same hardening bar as A2):

- **Honest auth** (`src/claude/auth.ts`) — `probe()` reports only REAL configured
  credentials (Anthropic API key / Bedrock / Vertex); when none is set it says so
  and names the env vars, and NEVER implies claude.ai subscription reuse (§5.5).
- **`ClaudeAgentDriver`** (`src/claude/driver.ts`) — drives the SDK `query()`;
  maps its message stream (system/assistant/result) → `RuntimeEvent`. Resumes a
  scope by **explicit `session_id`** (`resume: <id>`) — never `continue: true`
  (no "most-recent-in-cwd" guessing). `canUseTool` enforces a deny-list +
  allow-list (PreToolUse-style); Mingle capabilities ride an in-process SDK-MCP
  server so the model never holds a long-lived Agent credential (§10).
- **Dependency-free core** — the driver takes an injected structural `QueryFn`
  (`src/claude/sdk-types.ts`), unit-tested via `FakeClaudeQuery`. The real SDK is
  a DYNAMIC import (`src/claude/real-query.ts`) + an **optional** dependency, so
  the core builds/tests without it.
- **Restart-recovery** (`test/claude-restart-recovery.test.ts`) — SQLite-persisted
  `session_id` is resumed by a fresh process via `resume` (spy-verified), no new
  session. Two scopes → two distinct session_ids.
- **Real-SDK smoke** (`test/claude-smoke.test.ts`) — runs one real turn when the
  SDK is installed AND auth env is present; auto-skips otherwise (honest degrade).
  `claude -p` remains diagnostics-only.

## Codex review hardening (P1-5, P1-3)

- **P1-5 — one trusted Wake Packet → provider input** (`src/runtime/wake-render.ts`):
  a single runtime-layer renderer used by BOTH drivers. It separates the immediate
  event from notifications (framed as CONTEXT, not commands), preserves source +
  reply metadata + trace, and renders a heartbeat as a periodic wake with its
  background activity (never the bare `(heartbeat)`). Driver tests inspect the
  ACTUAL App Server turn input / SDK prompt for DM, channel-@, and heartbeat+
  notifications fixtures.
- **P1-3 — group/@ channel scope + reply** (`src/protocol/scope.ts`,
  `src/runtime/consumer.ts`): channel wakes resume a stable `channel:<id>` session
  and `deliverReply()` posts back to the channel via `postToChannel`. An
  UNSUPPORTED reply target (e.g. task) NACKs instead of silently ACKing, so the
  reply is never lost.

## Status — Increment A4 (OpenClaw adapter + unified install)

- **`OpenClawDriver`** (`src/openclaw/driver.ts`) — adapts the OpenClaw **Gateway
  lifecycle** (§5.6), NOT a re-spawned `openclaw` CLI: a Mingle scope_key maps to a
  Gateway session, one wake runs one Gateway turn, the reply maps to `RuntimeEvent`s.
  Feeds the SAME `renderWakeInput()` every driver uses (full-context group @ / DM /
  heartbeat). Depends on a structural `OpenClawGateway` (`src/openclaw/gateway.ts`),
  with `FakeGateway` for tests; capabilities declared honestly (`streaming:false`).
- **Driver registry** (`src/runtime/driver-registry.ts`) — `resolveDriver(kind, deps)`
  for codex / claude-code / openclaw + `driverCapabilities(kind)` for honest UI degrade.
- **Unified install descriptor** (`src/install/describe.ts`) — the honest, per-runtime
  install facts (App Server / Agent SDK / Gateway adapter, persistent resumable
  sessions, real auth). A test asserts NO stale "headless" / "常驻连接器" / "codex exec"
  / "claude -p" wording and no claude.ai subscription claim. This is the source of
  truth for the bind-agent copy rewrite (drafted separately, shipped to im-web after
  team-lead approval).

## Status — Increment A5 (WorkBuddy / CodeBuddy ACP driver)

Tencent **WorkBuddy** as a Local Agent, verified end-to-end against WorkBuddy 2.106.4
(codebuddy 2.106.4) + a real im-server:

- **`WorkBuddyAcpDriver`** (`src/workbuddy/driver.ts`) — drives `codebuddy --acp` (ACP =
  JSON-RPC over stdio). A scope_key maps to an ACP session; one wake runs one
  `session/prompt`; `session/update` notifications (`agent_message_chunk`, `tool_call`)
  map to `RuntimeEvent`s via the pure mapper (`src/workbuddy/updates.ts`, unmodelled
  updates ignored). Reply-text path only (v1); resume via `session/load` when the agent
  advertises `loadSession`, else it throws honestly. Reuses the codex `jsonrpc-stdio`
  transport; client in `src/workbuddy/client.ts`.
- **Launcher** (`src/workbuddy/spawn.ts`) — `codebuddy` is often NOT on PATH; it ships
  **embedded in the WorkBuddy desktop app**. `resolveCodebuddyLauncher()` prefers a PATH
  `codebuddy`, else runs the app's embedded CLI via its bundled Electron in Node mode
  (macOS `/Applications/WorkBuddy.app`; override with `WORKBUDDY_APP` / `WORKBUDDY_CODEBUDDY`).
- **YOLO + workspace cwd** — spawns `--permission-mode bypassPermissions` (tool use never
  blocks) and sets the **child process cwd** = the binding dir, because codebuddy's tools
  operate in the process cwd, NOT the `session/new` cwd param (verified live).
- **Tests** drive a **real** `codebuddy` (no fake), gated by a loud preflight skip when
  absent: initialize/session smoke, a full-daemon e2e (owner DM → reply) and a YOLO tool
  turn (DM → agent writes a file into its workspace). Registered as runtime kind
  `workbuddy` (registry + `describe.ts` + factory); `setup` prints a WorkBuddy-specific
  onboarding guide (persist into `~/.workbuddy/skills`, then mirror identity to Mingle).

## Next

- **bind-agent.tsx copy** — draft in `docs/bind-agent-copy-draft.md`; ship to im-web
  after the team-lead approves the wording.
- **P1-2 (held)** — replace the hand-copied Wake Packet builder with the shared
  schema-versioned adapter + cross-repo fixtures once the team-lead publishes them.

## Dev

```bash
npm install
npm run typecheck
npm test
```
