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
 * We now only strip a `user` message that IS the rendered envelope: it starts either
 * with the wake banner (no-persona render) or with the `## Who you are` persona header,
 * and the banner line is immediately followed by a known injected section header.
 * Assistant/system content is never dropped for containing a marker.
 *
 * The persona is inserted VERBATIM by the renderer and real personas (Codex `AGENTS.md`,
 * Claude agent files) contain blank lines / multiple paragraphs — so we must NOT stop
 * at the first blank line looking for the banner. Instead: once we've confirmed the
 * message opens with the render's own delimiter (banner-as-line-0, or the `## Who you
 * are` header), we SCAN forward for the banner line and require the injected section
 * header right after it. Owner content that merely QUOTES a banner mid-prose does not
 * open with either delimiter, so it survives.
 */
const WAKE_BANNER = /^\[Mingle wake · agent .+? · trace .+?\]$/;
const PERSONA_HEADER = /^## Who you are$/;
const INJECTED_SECTION =
  /^## (?:Owner context refresh —|Immediate event —|Heartbeat —)/;

/**
 * True only when `text` IS the runtime's rendered wake envelope for a `user` message:
 * the FIRST non-empty line is either the `[Mingle wake · …]` banner (no-persona render)
 * or the `## Who you are` persona header (persona render), AND the banner line — found by
 * scanning forward, tolerating a multi-paragraph persona body — is immediately followed
 * (after blank separators) by a known injected task section header. Anything that merely
 * mentions a marker mid-message (owner content that does not OPEN with the render's own
 * delimiter) returns false.
 */
function isRuntimeInjectedPreamble(text: string): boolean {
  const lines = text.split("\n");
  // Skip leading blanks to the message's first real line.
  let start = 0;
  while (start < lines.length && lines[start]!.trim() === "") start += 1;
  const first = lines[start]?.trim();
  if (first === undefined) return false;

  // The message must OPEN with the render's own delimiter: either the banner itself
  // (persona omitted) or the persona header (`## Who you are`). Owner prose that only
  // quotes a banner later does not open with either → survives.
  const opensAtBanner = WAKE_BANNER.test(first);
  if (!opensAtBanner && !PERSONA_HEADER.test(first)) return false;

  // Locate the banner line. When the message opens at the persona header, the persona
  // body is inserted verbatim (may contain blank lines / paragraphs), so we SCAN for the
  // banner rather than stopping at the first blank line.
  let bannerIdx = -1;
  if (opensAtBanner) {
    bannerIdx = start;
  } else {
    for (let i = start + 1; i < lines.length; i += 1) {
      if (WAKE_BANNER.test(lines[i]!.trim())) {
        bannerIdx = i;
        break;
      }
    }
  }
  if (bannerIdx === -1) return false;

  // The banner must be immediately followed (after blank separators) by exactly one of
  // the runtime's injected task section headers — the render's verified second delimiter.
  let j = bannerIdx + 1;
  while (j < lines.length && lines[j]!.trim() === "") j += 1;
  return lines[j] !== undefined && INJECTED_SECTION.test(lines[j]!.trim());
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
