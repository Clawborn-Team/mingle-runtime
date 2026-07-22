import type { SessionSource } from "./types.js";

const SECRET = /\b(?:sk-[A-Za-z0-9_-]{8,}|(?:API_KEY|TOKEN|SECRET|PASSWORD)\s*=\s*[^\s"']+)/gi;
const ABSOLUTE_PATH = /(?:\/Users|\/home|\/private|\/var\/folders)\/[A-Za-z0-9_./-]+/g;
const NOISE = /^(?:diff --git|@@ |\+\+\+ |--- |npm (?:warn|error)|yarn error|tool(?:_result)?\b)/i;

/**
 * The runtime's OWN injected wake input, echoed back inside a provider session as a
 * user message (`renderWakeInput` in ../runtime/wake-render.ts). It is runtime-authored
 * framing — an optional persona block (`## Who you are\n…`), the `[Mingle wake · … ·
 * trace …]` banner, then exactly one task section (owner-context / immediate-event /
 * heartbeat) optionally followed by notifications. It is NOT the owner's own content,
 * and if left in it crowds real owner work out of the char budget (a codex window kept
 * only 5 of 23 sessions). Strip it before budgeting.
 *
 * P1-5: match the renderer's COMPLETE, role-aware envelope, not either marker in
 * isolation. The old code applied a `/m`-anchored heading regex and an UNANCHORED wake
 * banner to EVERY role and dropped the WHOLE message on any hit — so a real owner /
 * assistant message that merely CONTAINED a `## Who you are` line, or QUOTED a wake
 * banner, was discarded (possibly the exact owner decision a refresh had to preserve).
 * We now only strip a `user` message whose START is the rendered envelope: an optional
 * persona block, then the wake banner as its own line, then a known injected section
 * header. Assistant/system content is never dropped for containing a marker.
 */
const WAKE_BANNER = /^\[Mingle wake · agent .+? · trace .+?\]$/;
const PERSONA_HEADER = /^## Who you are$/;
const INJECTED_SECTION =
  /^## (?:Owner context refresh —|Immediate event —|Heartbeat —)/;

/**
 * True only when `text` STARTS with the runtime's rendered wake envelope for a `user`
 * message: [optional `## Who you are` persona block] → the `[Mingle wake · …]` banner
 * line → a known injected task section header. Anything that merely mentions a marker
 * mid-message (owner content) returns false.
 */
function isRuntimeInjectedPreamble(text: string): boolean {
  const lines = text.split("\n");
  let i = 0;
  // Optional persona block: `## Who you are` then persona text up to the blank line
  // that the renderer always emits before the wake banner.
  if (lines[i] !== undefined && PERSONA_HEADER.test(lines[i]!.trim())) {
    i += 1;
    while (i < lines.length && lines[i]!.trim() !== "") i += 1; // consume persona body
    while (i < lines.length && lines[i]!.trim() === "") i += 1; // consume blank separator(s)
  }
  // The wake banner must be the next non-empty line (the renderer emits it as its own line).
  if (lines[i] === undefined || !WAKE_BANNER.test(lines[i]!.trim())) return false;
  i += 1;
  while (i < lines.length && lines[i]!.trim() === "") i += 1; // consume blank separator(s)
  // Followed by exactly one of the runtime's task section headers.
  return lines[i] !== undefined && INJECTED_SECTION.test(lines[i]!.trim());
}

export function sanitizeSessions(sessions: SessionSource[], opts: { maxSessionChars?: number; maxTotalChars?: number } = {}): SessionSource[] {
  const maxSession = opts.maxSessionChars ?? 12_000;
  let remaining = opts.maxTotalChars ?? 48_000;
  const output: SessionSource[] = [];
  for (const session of sessions) {
    let sessionRemaining = Math.min(maxSession, remaining);
    const messages = [];
    for (const message of session.messages) {
      // Drop the runtime's own injected wake/persona/task preamble BEFORE budgeting so
      // real owner content isn't evicted by text the runtime itself fed the model. Only a
      // `user` message whose START is the full rendered envelope is treated as injected —
      // never assistant/owner content that merely mentions a marker (P1-5).
      if (
        message.role === "tool" ||
        NOISE.test(message.text.trim()) ||
        (message.role === "user" && isRuntimeInjectedPreamble(message.text))
      ) {
        continue;
      }
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
