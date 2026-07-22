> **HISTORICAL** (build history) · Up-edge: [README.md](README.md) — kept for provenance; current design lives in [design.md](design.md)/[architecture.md](architecture.md).

# bind-agent.tsx copy rewrite — DRAFT for team-lead approval

> The runtime model changed: no more "常驻连接器 + headless 驱动 (codex exec / claude -p)".
> The real model is **Mingle Runtime** driving providers through their real integration
> surfaces with **persistent, resumable, per-scope sessions**: Codex **App Server**,
> Claude **Agent SDK**; OpenClaw is a **Gateway adapter**. This draft rewrites the three
> stale strings. **Do not ship until approved.** File:
> `im-web/app/app/(workspace)/agents/bind-agent.tsx` (+ maybe `im-web/lib/agent-skill.ts`).

## 1) RUNTIME_META blurbs (lines 11–13)

**Current (stale):**
```
{ id: "openclaw",    label: "OpenClaw 龙虾", icon: "🦞", blurb: "已有 OpenClaw Gateway，发一段 prompt 给龙虾即可" },
{ id: "claude-code", label: "Claude Code",  icon: "◆",  blurb: "常驻连接器 headless 驱动 `claude`，读你真实仓库/近况" },
{ id: "codex",       label: "Codex",        icon: "◇",  blurb: "常驻连接器 headless 驱动 `codex exec`（只读沙箱）" },
```

**Proposed:**
```
{ id: "openclaw",    label: "OpenClaw 龙虾", icon: "🦞", blurb: "接到你现有的 OpenClaw Gateway，作为适配器运行——发一段 prompt 给龙虾即可" },
{ id: "claude-code", label: "Claude",       icon: "◆",  blurb: "通过 Claude Agent SDK 驱动，按会话持久、可恢复；读你真实仓库/近况" },
{ id: "codex",       label: "Codex",        icon: "◇",  blurb: "通过 Codex App Server 驱动，按会话持久线程、可恢复；每轮显式沙箱" },
```
(Optionally relabel "Claude Code" → "Claude" since it's the Agent SDK, not the Code CLI. Flagging — your call on the label.)

## 2) The "在你的机器上运行" section header (line ~241)

**Current (stale):**
```
◆ {codeRuntimes.join(" / ")}：在你的机器上运行（常驻连接器）
```

**Proposed:**
```
◆ {codeRuntimes.join(" / ")}：在你的机器上运行（Mingle Runtime · 会话持久可恢复）
```

## 3) Optional — agent-skill.ts connect blurb

`im-web/lib/agent-skill.ts` `buildConnectCommand` has a comment: *"the standalone connector — NOT the OpenClaw plugin"* and the printed line says "then run the daemon". That comment is developer-facing (not user copy), but if we want consistency I can update the comment to "Mingle Runtime daemon" wording. **Not touching the actual command** — only wording. Flagging; leave as-is unless you want it.

## Guardrails I'll honor when I ship this

- Only the wording changes — no behavior, no command changes, no flow changes.
- Keep it accurate to the real Runtime (App Server / Agent SDK / Gateway adapter,
  persistent resumable per-scope sessions). No "headless", no "codex exec / claude -p"
  as the primary path, no claude.ai subscription implication.
- Verify `im-web` builds locally before proposing the push; coordinate the actual
  push/deploy with you (im-web → Vercel).

## Open questions for you

1. Relabel "Claude Code" → "Claude" in RUNTIME_META? (it's the Agent SDK now)
2. Update the developer-facing comment in agent-skill.ts, or leave it?
3. Any product-voice tweaks to the Chinese phrasing above?
