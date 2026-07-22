> **HISTORICAL** (build history) · Up-edge: [README.md](README.md) — kept for provenance; current design lives in [design.md](design.md)/[architecture.md](architecture.md).

# Increment A4 — OpenClaw adapter + unified install + bind-agent copy

> Part of Workstream A. Spec §5.6 (OpenClaw driver), §9.1 (本机安装), §5.7 (multi-agent).
> The bind-agent.tsx copy edit touches im-web (Vercel) — DRAFT + team-lead approval
> BEFORE committing/pushing it. Skill workflow: this plan → executing-plans with TDD.

## What A4 is (and isn't)

- **OpenClawDriver** — an `AgentRuntimeDriver` that ADAPTS the OpenClaw Gateway/plugin
  lifecycle (§5.6): it does NOT re-spawn the `openclaw` CLI and scrape stdout, and it
  does NOT re-implement OpenClaw's Gateway/session/routing. It bridges: Mingle
  scope_key → the Gateway's session key; hands the rendered wake to the Gateway to run
  ONE turn; streams the reply back as unified `RuntimeEvent`s. The Gateway owns the
  agent loop, tools, and channel routing.
- **Driver registry / capability-based selection** — a small factory that picks a
  driver by `runtime_kind` and reports its capabilities, so the runtime degrades the UI
  honestly per driver (already have Codex/Claude; add OpenClaw).
- **bind-agent.tsx copy** — replace the stale "常驻连接器 headless 驱动 `claude` / `codex
  exec`" wording with the real driver model (Codex App Server / Claude Agent SDK,
  persistent resumable per-scope sessions; OpenClaw = Gateway adapter). DRAFT ONLY here;
  ship to im-web after the team-lead approves the wording.

## Testability seam (no real Gateway in unit tests)

- The driver depends on a structural **`OpenClawGateway`** interface (open/resume a
  session by key, run one turn returning a reply + optional tool events, interrupt),
  matching the Gateway's channel-runtime surface we learned from
  `openclaw-mingle/src/inbound.ts` (inbound.run / reply / session). A **`FakeGateway`**
  drives the tests; a real adapter over `PluginRuntime` lands when wired to a live
  Gateway (kept behind the same interface, dynamic — no hard openclaw dep in core).
- OpenClaw's session key ↔ Mingle scope_key mapping goes through the SAME Session
  Registry (§5.6), so restart-recovery + isolation reuse A2/A3 infra.

## TDD steps (red → green → commit)

- [ ] **S1 OpenClawDriver over a FakeGateway** — `test/openclaw-driver.test.ts`: kind
      "openclaw" + capabilities (streaming maybe false, tools true, resume true, honest
      degrade); openSession maps scope_key→gateway session; runTurn feeds the SHARED
      renderWakeInput() (P1-5) to the gateway and maps its reply → turn.started/
      assistant.delta/turn.completed; a gateway error → turn.failed. Implement
      `src/openclaw/gateway.ts` (interface + FakeGateway) + `src/openclaw/driver.ts`.
- [ ] **S2 scope/session parity** — two scopes → two gateway sessions; a follow-up on a
      scope resumes the same gateway session key (mirrors A2/A3). Reuses the registry.
- [ ] **S3 driver registry** — `test/driver-registry.test.ts`: `resolveDriver(kind,
      deps)` returns the right driver for codex/claude-code/openclaw and exposes each
      one's capabilities for honest degrade. Implement `src/runtime/driver-registry.ts`.
- [ ] **S4 unified install descriptor** — `test/install.test.ts`: a pure
      `describeInstall(kind)` returns the honest, per-runtime install facts (what it
      drives, auth needs, that sessions persist/resume) with NO stale "headless" or
      "常驻连接器" language and no claude.ai claim. Implement `src/install/describe.ts`.
      (The command-builder / real installer is out of scope; this is the copy/data the
      unified installer + UI consume.)
- [ ] **S5 green gate** — typecheck + full suite; README A4 section. Commit.
- [ ] **S6 bind-agent copy DRAFT** — write the proposed new copy to `docs/bind-agent-copy-draft.md`
      (NOT touching im-web). Send to team-lead for approval. Only after approval: edit
      `im-web/.../agents/bind-agent.tsx` + `im-web/lib/agent-skill.ts` blurbs, verify
      im-web build, and coordinate the push.

## Constraints kept

- Drivers don't import each other; OpenClaw deps isolated under `src/openclaw/`, and the
  real Gateway binding is dynamic/optional so the core builds without openclaw.
- One active consumer per Agent credential (§5.6 migration note) — the registry key is
  per binding, and the runtime enforces a single consumer per binding.
- No CLI-scraping: the driver talks to the Gateway runtime surface, not `openclaw` stdout.
