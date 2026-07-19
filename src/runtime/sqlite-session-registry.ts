/**
 * SQLite-backed Session Registry (spec §5.3) — the persistent form of the
 * in-memory registry. It exists so a scope's provider session/thread id SURVIVES
 * a process restart: on reboot the runtime reads back `(binding, scope) →
 * thread_id` and `thread/resume`s it instead of starting a fresh thread. That
 * cross-restart recovery is the whole point of the App Server model over the old
 * headless drivers (§5.4).
 *
 * Stores only the mapping + status — never chat bodies, never secrets (those go
 * to the OS keychain). Uses Node's built-in `node:sqlite` (no native dep).
 */
import { DatabaseSync } from "node:sqlite";
import type {
  RuntimeKind,
  SessionHealth,
  SessionRegistry,
  SessionRow,
  SessionStatusPatch,
} from "./session-registry.js";

export class SqliteSessionRegistry implements SessionRegistry {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        binding_id                 TEXT NOT NULL,
        scope_key                  TEXT NOT NULL,
        agent_account_id           TEXT NOT NULL,
        runtime_kind               TEXT NOT NULL,
        provider_session_id        TEXT NOT NULL,
        runtime_profile_id         TEXT,
        cwd                        TEXT,
        permission_profile         TEXT,
        instruction_bundle_version TEXT,
        last_turn_at               INTEGER,
        health                     TEXT,
        PRIMARY KEY (binding_id, scope_key)
      );
    `);
  }

  async get(bindingId: string, scopeKey: string): Promise<SessionRow | undefined> {
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE binding_id = ? AND scope_key = ?")
      .get(bindingId, scopeKey) as Record<string, unknown> | undefined;
    return row ? rowToSession(row) : undefined;
  }

  async put(row: SessionRow): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO sessions
           (binding_id, scope_key, agent_account_id, runtime_kind, provider_session_id,
            runtime_profile_id, cwd, permission_profile, instruction_bundle_version, last_turn_at, health)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (binding_id, scope_key) DO UPDATE SET
           agent_account_id = excluded.agent_account_id,
           runtime_kind = excluded.runtime_kind,
           provider_session_id = excluded.provider_session_id,
           runtime_profile_id = excluded.runtime_profile_id,
           cwd = excluded.cwd,
           permission_profile = excluded.permission_profile,
           instruction_bundle_version = excluded.instruction_bundle_version,
           last_turn_at = excluded.last_turn_at,
           health = excluded.health`,
      )
      .run(
        row.bindingId,
        row.scopeKey,
        row.agentAccountId,
        row.runtimeKind,
        row.providerSessionId,
        row.runtimeProfileId ?? null,
        row.cwd ?? null,
        row.permissionProfile ?? null,
        row.instructionBundleVersion ?? null,
        row.lastTurnAt ?? null,
        row.health ?? null,
      );
  }

  async touch(bindingId: string, scopeKey: string, patch: SessionStatusPatch): Promise<void> {
    const existing = await this.get(bindingId, scopeKey);
    if (!existing) return;
    this.db
      .prepare(
        "UPDATE sessions SET last_turn_at = ?, health = ?, instruction_bundle_version = ? WHERE binding_id = ? AND scope_key = ?",
      )
      .run(
        patch.lastTurnAt ?? existing.lastTurnAt ?? null,
        patch.health ?? existing.health ?? null,
        patch.instructionBundleVersion ?? existing.instructionBundleVersion ?? null,
        bindingId,
        scopeKey,
      );
  }

  async listByBinding(bindingId: string): Promise<SessionRow[]> {
    const rows = this.db.prepare("SELECT * FROM sessions WHERE binding_id = ?").all(bindingId) as Record<
      string,
      unknown
    >[];
    return rows.map(rowToSession);
  }

  async delete(bindingId: string, scopeKey: string): Promise<void> {
    this.db.prepare("DELETE FROM sessions WHERE binding_id = ? AND scope_key = ?").run(bindingId, scopeKey);
  }

  close(): void {
    this.db.close();
  }
}

function rowToSession(row: Record<string, unknown>): SessionRow {
  const out: SessionRow = {
    bindingId: row.binding_id as string,
    scopeKey: row.scope_key as string,
    agentAccountId: row.agent_account_id as string,
    runtimeKind: row.runtime_kind as RuntimeKind,
    providerSessionId: row.provider_session_id as string,
  };
  if (row.runtime_profile_id != null) out.runtimeProfileId = row.runtime_profile_id as string;
  if (row.cwd != null) out.cwd = row.cwd as string;
  if (row.permission_profile != null) out.permissionProfile = row.permission_profile as string;
  if (row.instruction_bundle_version != null) out.instructionBundleVersion = row.instruction_bundle_version as string;
  if (row.last_turn_at != null) out.lastTurnAt = Number(row.last_turn_at);
  if (row.health != null) out.health = row.health as SessionHealth;
  return out;
}
