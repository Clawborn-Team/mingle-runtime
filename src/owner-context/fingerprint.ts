import { createHash } from "node:crypto";
import type { SessionSource } from "./types.js";

export function fingerprintSessions(sessions: SessionSource[]): string {
  const stable = sessions.map((session) => ({ provider: session.provider, sessionId: session.sessionId, project: session.project, updatedAt: session.updatedAt, messages: session.messages.map(({ role, text, timestamp }) => ({ role, text, timestamp: timestamp ?? "" })) }));
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
