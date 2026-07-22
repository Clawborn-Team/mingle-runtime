# mingle-runtime — documentation (subtree)

> **Up-edge:** workspace tree [`../../docs/README.md`](../../docs/README.md) ·
> workspace architecture [`../../docs/architecture.md`](../../docs/architecture.md) · repo entry [`../AGENTS.md`](../AGENTS.md).
> This repo owns its **internal** design/decisions here; the workspace tree stays macro/cross-repo
> (progressive disclosure — keep each doc small). Repo role: Local Agent daemon (AgentRuntimeDriver over Codex/Claude/OpenClaw/WorkBuddy).

## This repo's docs (standard per-repo structure)
Names without a link are **to author** (owner: `mingle-runtime-dev`); the authoring change creates the file
and turns the name into a link.

| Doc | Covers | Status |
|---|---|---|
| `architecture.md` | This repo's internal architecture (components, data flow, key contracts) | to author |
| `design.md` | Deeper module/component design | to author |
| `testing.md` | How this repo is tested (suite structure, fixtures); gate cmd → [workspace how-to/test](../../docs/how-to/test.md) | to author |
| `deploy.md` | This repo's deploy specifics → [workspace how-to/deploy](../../docs/how-to/deploy.md) | to author |
| [decisions/](decisions/README.md) | **Repo-internal** ADRs (macro/cross-repo decisions stay in [workspace decisions](../../docs/decisions/README.md)) | seeded |
| Existing loose docs | [plan-A1](plan-A1.md) · [plan-A2](plan-A2.md) · [plan-A3](plan-A3.md) · [plan-A4](plan-A4.md) · [bind-agent-copy-draft](bind-agent-copy-draft.md) — fold into the structure above | existing |

> Convention: workspace = cross-repo/macro; this subtree = repo-internal. **One fact, one home** — do
> not restate a workspace fact here, link to it. Every new doc adds a `> Up-edge:` line + a row above.
