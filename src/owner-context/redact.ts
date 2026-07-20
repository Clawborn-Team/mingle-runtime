import type { SessionSource } from "./types.js";

const SECRET = /\b(?:sk-[A-Za-z0-9_-]{8,}|(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[^\s"']+)/gi;
const ABSOLUTE_PATH = /(?:\/Users|\/home|\/private|\/var\/folders)\/[A-Za-z0-9_./-]+/g;
const NOISE = /^(?:diff --git|@@ |\+\+\+ |--- |npm (?:warn|error)|yarn error|tool(?:_result)?\b)/i;

export function sanitizeSessions(sessions: SessionSource[], opts: { maxSessionChars?: number; maxTotalChars?: number } = {}): SessionSource[] {
  const maxSession = opts.maxSessionChars ?? 12_000;
  let remaining = opts.maxTotalChars ?? 48_000;
  const output: SessionSource[] = [];
  for (const session of sessions) {
    let sessionRemaining = Math.min(maxSession, remaining);
    const messages = [];
    for (const message of session.messages) {
      if (message.role === "tool" || NOISE.test(message.text.trim())) continue;
      let text = message.text.replace(SECRET, "[REDACTED_CREDENTIAL]").replace(ABSOLUTE_PATH, "[LOCAL_PATH]");
      if (text.length > sessionRemaining) text = text.slice(0, Math.max(0, sessionRemaining));
      if (!text) continue;
      messages.push({ ...message, text });
      sessionRemaining -= text.length;
      remaining -= text.length;
      if (sessionRemaining <= 0 || remaining <= 0) break;
    }
    if (messages.length) output.push({ ...session, messages });
    if (remaining <= 0) break;
  }
  return output;
}
