# mingle-runtime — testing

> Up-edge: [README.md](README.md)
>
> The **merge gate command, shared discipline, and per-repo gate table** are canonical in the
> workspace [how-to/test.md](../../docs/how-to/test.md) (one fact, one home) — run and show that
> gate before claiming green. This doc adds only repo-internal detail: how the suite is laid out and
> why the deterministic gate excludes smoke.

## Why smoke is excluded from the gate

Smoke tests need **real Codex / Claude / WorkBuddy binaries or credentials on the machine** and are
flaky/environment-dependent, so bare `npm test` (= `vitest run`) is non-deterministic. That is *why*
the merge gate excludes them — the exact deterministic gate command is canonical in
[how-to/test.md](../../docs/how-to/test.md).

## Suite layout (vitest, `test/**/*.test.ts`)

Every provider integration follows the same **transport / protocol / driver + fake-peer** split so
the core is tested with no network and no process spawn:

- **Protocol / pure units** — `wake-packet` · `scope` · `wake-render` · `activity-summary` ·
  `definition` · `install-config`. No I/O.
- **Driver units over fakes** — each driver is exercised against an in-process fake that speaks the
  provider's real framing: `codex-driver` + `fake-app-server`, `claude-driver` + `fake-query`,
  `openclaw-driver` + a `FakeGateway`, `workbuddy-driver` + `workbuddy-updates`. Assert the native
  protocol maps correctly onto the unified `RuntimeEvent` stream + declared capabilities.
- **Consumer / loop** — `consumer` (scope → session → turn → reply), `consumer-nack` (the
  at-least-once discipline: failed turn NACKs + stops draining, bad packet drops + ACKs),
  `consumer-reply-targets` (DM vs channel-by-slug vs unsupported), `consumer-structured-question`
  (native question → one structured message, answer resumes the session), `daemon` (loop + backoff +
  digest with fakes).
- **Registry + persistence** — `session-registry` (in-memory contract), `sqlite-registry` +
  `restart-recovery` / `claude-restart-recovery` (a fresh registry on the same file resumes the
  stored session, no new session).
- **Transport** — `jsonrpc-stdio` (framing, correlation, server-initiated requests, split-chunk
  reassembly).
- **Owner-context** — `test/owner-context/*` (session discovery, redaction, the `owner-context-v1`
  contract).
- **Self-update / singleton / http-client / media-materializer** — the daemon-support units.

## Smoke + integration (excluded from the gate)

- `*smoke*` (`codex-smoke` · `claude-smoke` · `workbuddy-smoke` · `workbuddy-driver.smoke`) —
  spawn/dynamic-import the **real** provider and run one turn; auto-`skip` when the binary/SDK/auth
  is absent. Diagnostics for a real machine, not the deterministic gate.
- `test/integration/*.integration.test.ts` — `consumer-im-server` (against a live im-server via
  [`test/support/im-server.ts`](../test/support/im-server.ts)) and `workbuddy-e2e`. Run these when
  validating end-to-end wiring; the daily gate stays fast and hermetic.
