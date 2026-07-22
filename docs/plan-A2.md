> **HISTORICAL** (build history) · Up-edge: [README.md](README.md) — kept for provenance; current design lives in [design.md](design.md)/[architecture.md](architecture.md).

# Increment A2 — Codex App Server driver + NACK/backoff + SQLite persistence

> Part of Workstream A. Spec §5.4 (Codex App Server), §5.3 (registry persistence),
> §13.2 (Codex: new thread / resume / two-scope isolation / restart-recovery /
> approval / interrupt). Carry-forward from A2 review: (1) NACK/backoff vs drop+ACK
> (mirror im-server P0-3), (2) restart-recovery via SQLite + `thread/resume`.
> Skill workflow: this plan → executing-plans with **TDD**.

## Codex App Server facts (pulled from official docs 2026-07-19)

- Launch `codex app-server` over **stdio**; framing = **newline-delimited JSON
  (JSONL)**, one JSON-RPC message per line, `"jsonrpc":"2.0"` omitted on the wire.
- Handshake: `initialize` (req, params.clientInfo + capabilities.experimentalApi)
  → `initialized` (notif). One initialize per connection before any other method.
- `thread/start` {model, cwd, approvalPolicy, sandbox} → result.thread.{id,sessionId}.
- `thread/resume` {threadId} → thread. `thread/fork` {threadId, lastTurnId}.
- `turn/start` {threadId, input:[{type:"text",text}], cwd, approvalPolicy,
  sandboxPolicy:{type:"workspaceWrite",writableRoots,networkAccess}, model, effort}
  → result.turn.{id,status:"inProgress",items:[]}.
- `turn/interrupt` {threadId, turnId} → {} ; turn ends status "interrupted".
- `turn/steer` {threadId, input, expectedTurnId}.
- Notifications: `turn/started`{turn}, `turn/completed`{turn.status
  completed|interrupted|failed}, `item/started`{item}, `item/completed`{item},
  `item/agentMessage/delta`, `item/commandExecution/outputDelta`.
- Approvals = **server→client JSON-RPC requests**:
  `item/commandExecution/requestApproval` / `item/fileChange/requestApproval`
  {itemId,threadId,turnId,...}; client result = "accept"|"acceptForSession"|
  "decline"|"cancel".

## Design for testability (no real `codex` binary in unit tests)

Split transport from protocol from driver:

- **`JsonRpcStdioConnection`** — frames JSONL over a duplex (stdin/stdout of a
  child, OR an in-memory pair in tests). Correlates request id → response;
  dispatches server notifications + server-initiated requests to handlers.
- **`CodexAppServerClient`** — typed calls (initialize, threadStart, threadResume,
  turnStart, turnInterrupt) + a notification stream, over a connection.
- **`CodexAppServerDriver` implements AgentRuntimeDriver** — maps scope→thread
  (via registry), turn notifications → `RuntimeEvent`, approvals → `approval.requested`.
- **`FakeAppServer`** (test double) — an in-memory peer speaking the same JSONL
  protocol: answers initialize/thread/turn, emits the notification sequence, can
  script an approval request or a `turn/completed status:"failed"`.
- Real-binary launch (`spawn("codex", ["app-server"])`) lives behind
  `spawnCodexAppServer()`; a smoke test uses it only when `codex` is on PATH
  (else `it.skip`). `codex exec` stays a diagnostics-only fallback (§5.4), not the path.

## TDD steps (red → green → commit)

- [ ] **S1 JSON-RPC stdio connection** — `test/jsonrpc-stdio.test.ts`: over an
      in-memory duplex, a request gets its correlated response; a server
      notification reaches the handler; a server-initiated request is answered and
      the result is framed back; partial-line buffering reassembles split chunks.
      Implement `src/codex/jsonrpc-stdio.ts`.
- [ ] **S2 FakeAppServer + client handshake** — `test/codex-client.test.ts`:
      initialize→initialized→thread/start returns a thread id; turn/start streams
      turn/started → item/agentMessage/delta → item/completed → turn/completed;
      turn/interrupt yields status "interrupted". Implement `src/codex/fake-app-server.ts`
      + `src/codex/client.ts`.
- [ ] **S3 CodexAppServerDriver mapping** — `test/codex-driver.test.ts`: runTurn
      maps notifications → RuntimeEvent (turn.started/assistant.delta/turn.completed);
      a scripted approval request → `approval.requested` + `approve()` answers the
      server request; interrupt → turn.failed/interrupted; capabilities declared.
      Implement `src/codex/driver.ts`.
- [ ] **S4 two-scope isolation** — same driver/connection, two scope_keys open two
      distinct threadIds; a wake on scope A resumes A's thread, not B's.
- [ ] **S5 SQLite session registry** — `test/sqlite-registry.test.ts` (node:sqlite):
      put/get/touch/isolation parity with the in-memory impl; **restart-recovery** —
      a fresh registry opened on the same file returns the stored threadId; the
      consumer then `thread/resume`s it (assert resume called with that id, no new
      thread). Implement `src/runtime/sqlite-session-registry.ts`.
- [ ] **S6 NACK/backoff discipline (P0-3 carry-forward)** — extend the consumer:
      classify a driver turn that emits `turn.failed` (transient) → **NACK, do NOT
      ACK**; an unparseable/non-Mingle packet → drop + ACK. `test/consumer-nack.test.ts`:
      a failing turn NACKs (im-client.nack called, id NOT in ack list) and stops
      draining the batch; a bad packet still ACKs. Add `nack` to EventCenterClient.
- [ ] **S7 green gate** — typecheck + full suite; README A2 section + a skipped
      real-`codex` smoke test. Commit. Hand back unmerged.

## Constraints kept

- Secrets: the Codex driver never puts the Agent token in a prompt/log; provider
  creds resolve from env/keychain at spawn (keychain wiring stubbed w/ a clear
  seam — real store lands with the install flow). Do not echo tokens.
- `codex exec` / `claude -p` remain diagnostics only.
- Drivers don't import each other; Codex deps isolated under `src/codex/`.
