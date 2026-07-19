/**
 * A fake `query()` matching the Claude Agent SDK surface (`QueryFn`), so the
 * driver's message-mapping / resume / permission paths are deterministic unit
 * tests with no real SDK, credentials, or network. Scriptable: a normal reply,
 * an error result, or a tool_use step.
 */
import { randomUUID } from "node:crypto";
import type { QueryFn, QueryOptions, SdkMessage } from "./sdk-types.js";

export type FakeScript = "reply" | "error" | "tool-use";

export type FakeClaudeOptions = {
  reply?: string;
  /** When set, every non-resumed query mints this exact id (single-scope tests).
   *  When omitted, each fresh session gets a new random id — so two openSession
   *  calls naturally yield two distinct ids (isolation). */
  sessionId?: string;
  /** Kept for call sites that opt into fresh-per-session ids explicitly. */
  sessionIdPerScope?: boolean;
  onCall?: (call: { prompt: string; options?: QueryOptions }) => void;
};

export function fakeClaudeQuery(script: FakeScript = "reply", opts: FakeClaudeOptions = {}): QueryFn {
  const reply = opts.reply ?? "ok";
  const fixedId = opts.sessionIdPerScope ? undefined : opts.sessionId;

  function sessionIdFor(options?: QueryOptions): string {
    // Resuming → keep the id the caller passed (no continue:true guessing).
    if (options?.resume) return options.resume;
    // A fresh session: a fixed id for single-scope tests, else a new random id.
    return fixedId ?? `sess-${randomUUID()}`;
  }

  return async function* query(input: { prompt: string; options?: QueryOptions }): AsyncIterable<SdkMessage> {
    opts.onCall?.({ prompt: input.prompt, options: input.options });
    const sessionId = sessionIdFor(input.options);

    // init: carries the session_id
    yield { type: "system", subtype: "init", session_id: sessionId };

    // A priming (empty-prompt) query only establishes the session id.
    if (input.prompt === "") {
      yield { type: "result", subtype: "success", session_id: sessionId, result: "" };
      return;
    }

    if (script === "error") {
      yield { type: "result", subtype: "error_during_execution", session_id: sessionId, errors: ["boom"] };
      return;
    }

    if (script === "tool-use") {
      yield {
        type: "assistant",
        session_id: sessionId,
        message: { content: [{ type: "tool_use", id: "tu1", name: "Read", input: { path: "x" } }] },
      };
    }

    yield {
      type: "assistant",
      session_id: sessionId,
      message: { content: [{ type: "text", text: reply }] },
    };
    yield { type: "result", subtype: "success", session_id: sessionId, result: reply };
  };
}
