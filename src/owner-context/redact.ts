import type { SessionSource } from "./types.js";

const SECRET = /\b(?:sk-[A-Za-z0-9_-]{8,}|(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[^\s"']+)/gi;
const ABSOLUTE_PATH = /(?:\/Users|\/home|\/private|\/var\/folders)\/[A-Za-z0-9_./-]+/g;
const NOISE = /^(?:diff --git|@@ |\+\+\+ |--- |npm (?:warn|error)|yarn error|tool(?:_result)?\b)/i;

/**
 * The runtime's OWN injected wake input, echoed back inside a provider session as a
 * user message (`renderWakeInput` in ../runtime/wake-render.ts). It is runtime-authored
 * framing — persona (`## Who you are`), the `[Mingle wake · … · trace …]` banner, and
 * the task section (owner-context / immediate-event / heartbeat / notifications). It is
 * NOT the owner's own content, and if left in it crowds real owner work out of the
 * char budget (a codex window kept only 5 of 23 sessions). Strip it before budgeting.
 */
const INJECTED_WAKE = /\[Mingle wake · agent .+? · trace .+?\]/;
const INJECTED_HEADERS =
  /^## (?:Who you are|Owner context refresh —|Immediate event —|Heartbeat —|Background notifications —)/m;

function isRuntimeInjected(text: string): boolean {
  return INJECTED_WAKE.test(text) || INJECTED_HEADERS.test(text);
}

export function sanitizeSessions(sessions: SessionSource[], opts: { maxSessionChars?: number; maxTotalChars?: number } = {}): SessionSource[] {
  const maxSession = opts.maxSessionChars ?? 12_000;
  let remaining = opts.maxTotalChars ?? 48_000;
  const output: SessionSource[] = [];
  for (const session of sessions) {
    let sessionRemaining = Math.min(maxSession, remaining);
    const messages = [];
    for (const message of session.messages) {
      // Drop the runtime's own injected wake/persona/task preambles BEFORE budgeting so
      // real owner content isn't evicted by text the runtime itself fed the model.
      if (message.role === "tool" || NOISE.test(message.text.trim()) || isRuntimeInjected(message.text)) continue;
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
