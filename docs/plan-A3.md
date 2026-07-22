> **HISTORICAL** (build history) · Up-edge: [README.md](README.md) — kept for provenance; current design lives in [design.md](design.md)/[architecture.md](architecture.md).

# Increment A3 — Claude Agent SDK driver

> Part of Workstream A. Spec §5.5 (Claude Agent SDK), §5.3 (session persistence),
> §13.2 (Claude: new session / resume / two-scope isolation / restart-recovery /
> hook deny / custom Mingle tool). Same bar as A2. NACK/backoff is already in the
> shared consumer (CodexDriver + ClaudeDriver share runBindingOnce). Skill workflow:
> this plan → executing-plans with **TDD**.

## Claude Agent SDK facts (pulled from current docs 2026-07-19, SDK v0.3.215)

- `query({ prompt, options })` returns an async iterable of messages. One `query()`
  drives a whole turn (the agent loop runs to completion inside it).
- **Explicit resume:** `options.resume = sessionId` (a specific id). `forkSession:
  true` (with `resume`) branches. `continue: true` = "most recent in cwd" — we do
  NOT use it (§5.5 no-guessing).
- **session_id** is on the init `SystemMessage` (`{type:"system",subtype:"init",
  session_id,...}`) AND on every `SDKResultMessage` (`{type:"result",subtype:
  "success"|"error_*",session_id,result}`). Assistant text: `{type:"assistant",
  message:{content:[{type:"text",text}|{type:"tool_use",name,...}]}}`.
- Options we use: `cwd`, `allowedTools`, `mcpServers` (in-process via
  `createSdkMcpServer` + `tool(name,desc,zodShape,handler)`), `canUseTool`
  (`(toolName,input)=>{behavior:"allow"|"deny",updatedInput?,message?}`) for
  PreToolUse-style permission, `permissionMode`, `resume`, `forkSession`.
- **Auth (§5.5):** SDK defaults to `ANTHROPIC_API_KEY`; also `CLAUDE_CODE_USE_BEDROCK=1`
  / `CLAUDE_CODE_USE_VERTEX=1`. We surface the REAL configured method and never
  imply claude.ai subscription reuse.
- Sessions persist to `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`; resume
  needs the same cwd → we always pass an explicit stable `cwd` per binding.

## Design for testability (no real SDK/creds in unit tests)

- The driver takes an injected **`QueryFn`** (structural type matching the SDK's
  `query`), so unit tests pass a fake that yields scripted SDK messages. The real
  SDK is a **dynamic import** only in the smoke/spawn path → core stays dep-free,
  typecheck needs no SDK install.
- **`FakeClaudeQuery`** (test helper) — yields a scripted message sequence: init
  (with session_id) → assistant text → result; scriptable for a tool_use +
  permission (canUseTool) path and an error result.
- Session model: unlike Codex threads, a Claude session is resumed per `query()`
  via `resume: sessionId`. `openSession` runs a priming/first query to mint the
  session_id (or defers it to the first turn); `runTurn` calls
  `query({resume, cwd, allowedTools, mcpServers, canUseTool})` and captures the
  session_id from the init/result message. Registry stores that id (SQLite from A2).
- Auth honesty lives in `probe()` — reads env truthfully, lists methods.

## TDD steps (red → green → commit)

- [ ] **S1 auth probe** — `test/claude-auth.test.ts`: given env with ANTHROPIC_API_KEY
      → probe reports method "anthropic-api-key" ok; with CLAUDE_CODE_USE_BEDROCK →
      "bedrock"; none → available:false with an honest message and NO claude.ai
      claim. Implement `src/claude/auth.ts` (pure env→methods) — no network.
- [ ] **S2 message mapping** — `test/claude-driver.test.ts`: over a FakeClaudeQuery,
      runTurn maps init→(capture session_id), assistant text→assistant.delta,
      result success→turn.completed(text), result error→turn.failed. Implement
      `src/claude/fake-query.ts` + `src/claude/driver.ts` (kind "claude-code",
      capabilities: streaming/tools/approvals/resume true, fileChanges true).
- [ ] **S3 resume + no continue-guessing** — a second turn on the same scope calls
      query with `resume: <captured id>` and NEVER `continue: true` (assert the
      options the fake received). openSession→resumeSession round-trips the id.
- [ ] **S4 permission (hook deny) + custom Mingle tool** — canUseTool denies a
      disallowed tool → surfaces as approval flow / denial; the in-process Mingle
      tool (createSdkMcpServer/tool) is registered in mcpServers and its schema is
      restricted. Test asserts a denied tool yields deny behavior and the Mingle
      tool is present in the query options.
- [ ] **S5 two-scope isolation** — two scope_keys → two distinct session_ids; a
      wake on scope A resumes A's id, not B's (mirror A2).
- [ ] **S6 restart-recovery** — SQLite registry (reuse A2) persists the Claude
      session_id; a fresh process (new registry on same file + fresh driver)
      resumes the SAME session_id via `resume` (spy-verified), no new session.
- [ ] **S7 green gate** — typecheck + full suite; a real-SDK smoke test that
      dynamic-imports @anthropic-ai/claude-agent-sdk and runs one query, auto-skipped
      when the SDK isn't installed OR no auth env is present. README A3 section.
      Commit. Hand back unmerged.

## Constraints kept

- Secrets/§10: the Agent token never enters a prompt/tool-result/log; provider
  creds resolve from env/keychain (ANTHROPIC_API_KEY etc.), the Mingle tool shim
  holds any short-lived Agent capability out of the model's reach. Keychain wiring
  stubbed w/ a clear seam (real store = A4 install flow).
- §5.5 auth honesty: probe surfaces real methods; no claude.ai subscription claim.
- `claude -p` stays diagnostics-only; the SDK `query()` is the path.
- Drivers don't import each other; Claude deps isolated under `src/claude/`; the
  real SDK is an OPTIONAL/dynamic dep so the core installs without it.
