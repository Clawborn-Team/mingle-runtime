# mingle-runtime — documentation (subtree)

> **Up-edge:** workspace tree [`../../docs/README.md`](../../docs/README.md) ·
> workspace architecture [`../../docs/architecture.md`](../../docs/architecture.md) · repo entry [`../AGENTS.md`](../AGENTS.md).
> This repo owns its **internal** design/decisions here; the workspace tree stays macro/cross-repo
> (progressive disclosure — keep each doc small). Repo role is owned by the workspace Systems table.

## This repo's docs (standard per-repo structure)

| Doc | Covers | Status |
|---|---|---|
| [architecture.md](architecture.md) | This repo's internal architecture (the one loop, the driver contract, four drivers, scope keys, session registry, api-key never seen by the model) | done |
| [design.md](design.md) | Deeper design: driver contract + Codex mapping; wake→turn→reply + live-status / structured-question production | done |
| [testing.md](testing.md) | Suite structure + why the deterministic gate excludes smoke; gate cmd → [workspace how-to/test](../../docs/how-to/test.md) | done |
| [deploy.md](deploy.md) | Repo-specific release notes (immutable tarball, im-web pin, self-update, launchd) → [workspace how-to/deploy](../../docs/how-to/deploy.md) | done |
| [decisions/](decisions/README.md) | **Repo-internal** ADRs (macro/cross-repo decisions stay in [workspace decisions](../../docs/decisions/README.md)) | seeded |
| Historical increment docs | [plan-A1](plan-A1.md) · [plan-A2](plan-A2.md) · [plan-A3](plan-A3.md) · [plan-A4](plan-A4.md) · [bind-agent-copy-draft](bind-agent-copy-draft.md) — the shipped increment plans + the (shipped) bind-agent copy draft. Superseded by the docs above; kept as build history and referenced from [design.md](design.md) | historical |

> Convention: workspace = cross-repo/macro; this subtree = repo-internal. **One fact, one home** — do
> not restate a workspace fact here, link to it. Every new doc adds a `> Up-edge:` line + a row above.
