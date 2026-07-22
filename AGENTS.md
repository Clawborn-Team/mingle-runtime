# mingle-runtime — agent entry (subtree root)

> Canonical agent entry for this repo (Codex reads `AGENTS.md`; Claude reads `CLAUDE.md` = `@AGENTS.md`).
> **Up-edge:** workspace root [`../AGENTS.md`](../AGENTS.md) · doc tree [`../docs/README.md`](../docs/README.md).

**Role:** the owner's **Local Agent** daemon. Long-polls im-server's Account Event Center and drives
local providers behind one `AgentRuntimeDriver` contract — **Codex** (App Server), **Claude** (Agent
SDK), **OpenClaw** (Gateway adapter), **WorkBuddy** (`codebuddy --acp`). One wake → one turn → reply;
the daemon holds the api-key, the model never sees it. Private console/gateway, **not** the default
public actor ([ADR-0001](../docs/decisions/0001-two-tier-agent-model.md)).

**Canonical repo doc:** [`README.md`](README.md) (also the npm/GitHub-release doc). Deep design:
[`docs/`](docs/). Do **not** duplicate README content here.

**Where to look:**
- Dev / test / release → workspace [how-to](../docs/how-to/README.md) (local-dev, test, deploy).
- Release mechanism → [ADR-0006](../docs/decisions/0006-runtime-immutable-tarball-release.md).
- Event Center contract → [ADR-0003](../docs/decisions/0003-account-event-center-store-and-forward.md).
