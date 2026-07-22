# mingle-runtime — component design

> Up-edge: [README.md](README.md)
>
> Deeper design of the two load-bearing pieces: **(1)** the `AgentRuntimeDriver` contract and how a
> real provider (Codex) maps onto it, and **(2)** the wake → turn → reply pipeline including
> live-status and structured-question production. For the map of all parts see
> [architecture.md](architecture.md); the historical increment plans that built these are
> [plan-A1](plan-A1.md) (contract + registry + loop), [plan-A2](plan-A2.md) (Codex), [plan-A3](plan-A3.md)
> (Claude), [plan-A4](plan-A4.md) (OpenClaw + install).

## 1. The driver contract, and mapping one provider onto it

`AgentRuntimeDriver` ([`src/runtime/driver.ts`](../src/runtime/driver.ts)) is deliberately narrow so
four unrelated providers fit behind it. The design choices that make that work:

- **A turn is a *stream*, not a `respond(): Promise<string>`.** `runTurn` returns
  `AsyncIterable<RuntimeEvent>`. This is what lets the consumer produce live status mid-turn,
  intercept a native question, and distinguish a clean completion from a transient failure — all
  without waiting for the whole turn.
- **Sessions are explicit + persistable.** `ProviderSessionRef = { bindingId, scopeKey,
  providerSessionId }` is exactly what the Session Registry stores. `openSession` mints the provider
  session; `resumeSession` re-attaches it; the runtime — not a provider "most recent in cwd" guess —
  decides which session a wake belongs to.
- **Capabilities are declared, not assumed.** `RuntimeCapabilities` lets the runtime degrade the UI
  honestly (a provider without streaming still yields exactly one `assistant.delta`; a provider
  without file changes never emits `file.changed`).

### Codex mapping (representative)

`CodexAppServerDriver` ([`src/codex/driver.ts`](../src/codex/driver.ts)) shows the pattern each
driver follows — translate the provider's native protocol into the unified event stream:

- **scope → thread.** `openSession` → `thread/start`; `resumeSession` → `thread/resume` with the
  stored thread id. The registry's `providerSessionId` *is* the Codex thread id.
- **notifications → `RuntimeEvent`.** An `onNotification` handler maps `turn/started` →
  `turn.started`, `item/agentMessage/delta` → `assistant.delta`, `item/started` for
  commandExecution/mcpToolCall → `tool.started`, etc. A private `EventQueue` turns these pushed
  callbacks into the pulled `AsyncIterable` `runTurn` returns.
- **authoritative final text.** Streamed deltas are a nicety and can be absent; the driver prefers
  the full text from the last `item/completed` (agentMessage) for `turn.completed.text`, falling
  back to assembled deltas.
- **approvals stay out of the model's hands.** Codex approvals arrive as *server-initiated*
  JSON-RPC requests; the driver surfaces them as `approval.requested` and **holds the JSON-RPC
  response open** until `approve()` decides — the runtime/owner accepts or declines, the model never
  self-approves.

The Claude driver ([`src/claude/driver.ts`](../src/claude/driver.ts)) applies the same shape to the
Agent SDK: one `query({ resume, cwd, allowedTools, mcpServers, canUseTool })` per turn, SDK messages
mapped to the same events, `session_id` captured from the init/result message, and a `canUseTool`
gate that denies disallowed tools locally (a deny-list wins; the allow-list gates the rest).

## 2. wake → turn → reply

`processWake` ([`src/runtime/consumer.ts`](../src/runtime/consumer.ts)) is the pipeline for one
event:

1. **scope + session.** `deriveScopeKey` → registry `get`; resume if present, else `openSession` +
   `put`.
2. **media.** `materializeWakeMedia` downloads any wake attachments to local files (honoring the
   driver's `imageInputs` capability) and cleans them up after the turn.
3. **one turn.** Iterate `driver.runTurn(...)`, accumulating `assistant.delta` into `assistantText`
   and capturing `turn.completed.text` as the reply.
4. **`touch`** the registry with `lastTurnAt` + health (`error` if any `turn.failed`).
5. **deliver.** `deliverReply` routes by reply target: `dm` → `sendDm`, `channel` → `postToChannel`
   **by slug** (im-server posts by slug — the runtime recovers `channel_slug` from the raw event; a
   channel wake with no recoverable slug returns `unsupported` so the caller NACKs rather than
   mis-posting). A non-ok send **throws** so the caller NACKs instead of ACKing a lost reply.

### Live status (truthful "working on it")

As the turn streams, `summarizeEvent` ([`src/runtime/activity-summary.ts`](../src/runtime/activity-summary.ts))
reduces the latest event to a one-line summary, pushed via `imClient.postActivity(target, "working",
line)`; on completion the line is cleared (`done` / `failed`). It is **best-effort** (optional on the
client, never blocks the turn) and targets the DM peer or broadcasts to channel members. This is the
runtime half of the workspace live-status spec (workspace [architecture.md](../../docs/architecture.md)
§5).

### Structured questions (no suspended turns)

When a driver emits `question.raised` (Claude's native `AskUserQuestion`, intercepted so the SDK
never blocks on it), the driver **ends that round now** and the consumer delivers **one structured
`mingle.message.v1` message** carrying the question block(s) instead of a plaintext reply
(`buildQuestionMessage`). The person's answer arrives as a later wake that **resumes the same scope's
session naturally** — no turn is held open. `wake-render` frames that follow-up as "the person's
answer to a question you asked earlier" so the model continues its prior line of thought.

## Constraints these designs keep

- **Secrets never reach the model** — the api-key lives in the daemon/http-client; provider creds
  resolve from the provider's own store (codex keychain / `ANTHROPIC_API_KEY` / Bedrock / Vertex),
  never in a prompt, tool result, or log ([`src/runtime/factory.ts`](../src/runtime/factory.ts) §10).
- **Drivers are isolated** — no driver imports another; provider deps are optional/dynamic so the
  core installs and typechecks without any provider SDK.
- **The reply path is delivery-honest** — every non-happy path (`turn.failed`, thrown error,
  `unsupported` target, non-ok send) results in a NACK, never a silent ACK.
