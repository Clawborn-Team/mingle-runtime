# mingle-runtime — deploy / release

> Up-edge: [README.md](README.md)
>
> The **release steps, cross-repo order (incl. the im-web version pin), and daemon restart** are
> canonical in the workspace [how-to/deploy.md](../../docs/how-to/deploy.md); the release *decision*
> is [ADR-0006](../../docs/decisions/0006-runtime-immutable-tarball-release.md). One fact, one home —
> this doc adds only repo-internal mechanics; do not restate the runbook order or the pin coupling.

## Packaging layout (repo-internal)

- **Immutable GitHub Release tarball.** `npm pack` → renamed `mingle-runtime.tgz`, attached to a
  `vX.Y.Z` GitHub Release, so `npx -p <versioned-url> mingle-runtime …` is immutable + cached.
  The package name is `@clawborn/mingle-runtime` with `bin.mingle-runtime → dist/bin.js`
  ([`package.json`](../package.json)); `dist/` is built by `npm run build` (tsconfig.build) — the
  `files` allowlist ships `dist` + `skills` + `README.md`.
- **Version source of truth.** `RUNTIME_VERSION` ([`src/version.ts`](../src/version.ts)) is what the
  daemon reports on each Event Center poll — keep it in step with `package.json`. (How that version
  couples to the im-web pin lives in the workspace runbook + ADR-0006.)

## Managed self-update (repo-specific)

The daemon does not require a user reinstall to move versions. On each poll it reports
`RUNTIME_VERSION`; when im-server returns a `runtime.update` directive naming a strictly-newer
target, `pickRuntimeUpdate` + `applySelfUpdate`
([`src/runtime/self-update.ts`](../src/runtime/self-update.ts)) **relaunch the daemon via `npx` at
the target's versioned tarball URL**. Because npx caches by version URL, the new download is exactly
the target build; `~/.mingle` config persists so the fresh process resumes every binding.

## Local daemon (launchd)

The owner's daemon runs under launchd and npx-caches by version, so a **new release + restart** picks
up new code. The launchd label + the exact restart command are canonical in
[how-to/deploy.md → restarting the local daemon](../../docs/how-to/deploy.md#mingle-runtime--restarting-the-local-daemon).

## Runtime state on disk

- `~/.mingle/config.json` — bindings written by `mingle-runtime add`, mode `0600` (holds the agent
  api-key). Read at `start`.
- `~/.mingle/sessions.db` — the SQLite Session Registry (scope → provider session id), so a restart
  resumes rather than starting sessions cold ([`src/runtime/sqlite-session-registry.ts`](../src/runtime/sqlite-session-registry.ts)).

Provider credentials are **not** stored here — they stay with each provider (codex keychain /
`ANTHROPIC_API_KEY` / Bedrock / Vertex / the CodeBuddy CLI's own auth).
