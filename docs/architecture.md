# mingle-runtime — internal architecture

> Up-edge: [README.md](README.md)
>
> Repo-internal architecture. For where this daemon sits in the whole system see the workspace
> [architecture.md](../../docs/architecture.md) (§10 Local Agent runtime) and [ADR-0001 two-tier
> agent model](../../docs/decisions/0001-two-tier-agent-model.md). The Event Center contract it
> consumes is [ADR-0003](../../docs/decisions/0003-account-event-center-store-and-forward.md).
> **One fact, one home** — this doc describes only what lives *inside* the runtime.

## What it is

A long-running daemon on the owner's machine. It long-polls im-server's Account Event Center for
one or more agent bindings and turns each durable wake into exactly one provider turn, delivering
the agent's final message back to im-server. The daemon holds the agent api-key and does all
delivery; **the model never sees the key** ([`src/runtime/factory.ts`](../src/runtime/factory.ts)
header, §10).

## The one loop: wake → turn → reply

```
Event Center ──long-poll──▶ runBindingOnce ──per raw event──▶ processWake ──▶ deliverReply ──▶ ACK
   (GET /updates)              (drain batch)                    (one turn)      (DM / channel)
```

- **`runBindingLoop`** ([`src/runtime/daemon.ts`](../src/runtime/daemon.ts)) — the per-binding
  driver: threads the opaque Event Center cursor across polls, runs one `runBindingOnce` drain per
  iteration, fires a periodic digest heartbeat, and backs off on a thrown error. Bindings run
  concurrently and isolated (own driver, registry entry, http client).
- **`runBindingOnce` / `processWake`** ([`src/runtime/consumer.ts`](../src/runtime/consumer.ts)) —
  the heart. For each raw `{id,type,payload}` event it builds a Wake Packet locally
  ([`src/protocol/wake-adapter.ts`](../src/protocol/wake-adapter.ts) — im-server never pre-builds
  the packet), derives the scope key, opens-or-resumes that scope's provider session, drives **one
  turn**, and delivers the final assistant text to the packet's reply target.

### At-least-once delivery discipline

`runBindingOnce` mirrors im-server's per-event discipline (the P0-3 fix — ACK-on-failure loses
wakes): a **successful, delivered** turn ACKs; a **transiently failed** turn (`turn.failed`, a
thrown provider/network error, or an `unsupported` reply target) **NACKs and stops draining** so
the cursor is not advanced past the gap; an unparseable / non-actionable packet is dropped + ACKed.
Details in [design.md](design.md).

## The unified driver contract

Every provider is adapted behind one interface, `AgentRuntimeDriver`
([`src/runtime/driver.ts`](../src/runtime/driver.ts)):

- A turn **streams** a `RuntimeEvent` union (`turn.started` · `assistant.delta` · `tool.*` ·
  `approval.requested` · `file.changed` · `question.raised` · `turn.completed` · `turn.failed`) —
  the consumer accumulates deltas / final text and reacts to each event.
- Sessions are **explicit and resumable** (`openSession` / `resumeSession` / `runTurn` /
  `closeSession`), keyed by `(bindingId, scopeKey)`.
- Each driver **declares `RuntimeCapabilities`** (streaming / tools / approvals / fileChanges /
  resume / imageInputs) so the runtime degrades honestly and never fabricates events a provider
  cannot produce.

The shared contract/registry knows **four** adapter kinds — never importing each other, provider
deps isolated per subdir:

| kind | subdir | provider surface |
|---|---|---|
| `codex` | [`src/codex/`](../src/codex/) | `codex app-server` (stdio JSON-RPC); scope → thread, `thread/resume`. |
| `claude-code` | [`src/claude/`](../src/claude/) | Claude Agent SDK `query()`; explicit `session_id` + `resume`, `mingle_*` as in-process SDK-MCP. |
| `openclaw` | [`src/openclaw/`](../src/openclaw/) | adapts the owner's existing OpenClaw Gateway (does not re-spawn the CLI). |
| `workbuddy` | [`src/workbuddy/`](../src/workbuddy/) | CodeBuddy `codebuddy --acp` (ACP = JSON-RPC over stdio); `session/load` resume. |

`resolveDriver(kind, deps)` + `driverCapabilities(kind)`
([`src/runtime/driver-registry.ts`](../src/runtime/driver-registry.ts)) is the single place that
knows all four; heavy provider deps are injected so the core constructs a driver without importing
any provider SDK.

**The installed daemon factory constructs only three of them.**
[`src/runtime/factory.ts`](../src/runtime/factory.ts) is the provider-backed side of
`mingle-runtime start`: for an installed binding it does the real wiring (spawning the Codex App
Server, dynamic-importing the Claude SDK, spawning `codebuddy --acp`, building the HTTP client) for
`codex` / `claude-code` / `workbuddy`. The `openclaw` case **throws** — `mingle-runtime start`
cannot launch it, because the OpenClawDriver needs a live Gateway handle the install binding does
not carry. OpenClaw's production execution belongs to the native
[`openclaw-mingle`](../../openclaw-mingle/docs/README.md) Gateway plugin; the `openclaw` adapter
here exists to keep the driver contract uniform (and is exercised in tests against a fake Gateway).

## Scope keys — one identity, many sessions

`deriveScopeKey` ([`src/protocol/scope.ts`](../src/protocol/scope.ts)) fans one agent identity into
isolated sessions: `dm:<peer>` · `channel:<id>` · `owner:<id>` · `task:<id>`. Same scope on the next
wake → same provider session (resume); different DMs / channels are isolated. A heartbeat with no
conversation maps to the binding's `owner:` scope — but note the installed-binding adapter
(`toBinding` in [`src/runtime/daemon.ts`](../src/runtime/daemon.ts)) sets `ownerAccountId: b.agentId`,
a **stable agent-id fallback** scope key for heartbeat/ambient turns (never persisted into
im-server), *not* the owner's account identity.

## Session Registry

`SessionRegistry` ([`src/runtime/session-registry.ts`](../src/runtime/session-registry.ts)) maps
`(bindingId, scopeKey) → providerSessionId` + status. It stores **only** the mapping + status —
never chat bodies as a second source of truth, never secrets (those go to the OS keychain). The
in-memory impl backs tests; `SqliteSessionRegistry`
([`src/runtime/sqlite-session-registry.ts`](../src/runtime/sqlite-session-registry.ts)) persists it
so a daemon restart recovers every session and resumes rather than starting cold.

## Turn input & product feedback

- **Wake rendering** — one shared trusted renderer, `renderWakeInput`
  ([`src/runtime/wake-render.ts`](../src/runtime/wake-render.ts)), feeds every driver the *same*
  grounded input: the immediate event to handle now, background notifications framed as untrusted
  context (not commands), reply metadata, and a persona preamble.
- **Live status + structured questions** — the consumer summarizes intermediate events into a
  rolling one-line ephemeral activity (`postActivity`) and turns a driver's native
  `question.raised` into one structured `mingle.message.v1` message. See [design.md](design.md).

## Ancillary subsystems

- **Owner-context refresh** ([`src/owner-context/`](../src/owner-context/)) — an owner-initiated
  private task that mines local Claude/Codex session history into a redacted `owner-context-v1`
  report for the Companion; never exposes raw transcripts.
- **Self-update** ([`src/runtime/self-update.ts`](../src/runtime/self-update.ts)) — a platform
  `runtime.update` directive on the poll relaunches the daemon at the target's immutable tarball
  URL. See [deploy.md](deploy.md) + [ADR-0006](../../docs/decisions/0006-runtime-immutable-tarball-release.md).
- **Install / bindings** ([`src/install/`](../src/install/)) — `add` writes bindings to
  `~/.mingle/config.json` (`0600`, holds the api-key); the daemon reads them at `start`.
