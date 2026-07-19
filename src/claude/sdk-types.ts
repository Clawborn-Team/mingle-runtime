/**
 * Minimal structural types for the `@anthropic-ai/claude-agent-sdk` `query()`
 * surface we depend on (SDK v0.3.x). We type only what the driver reads so the
 * core needs NO dependency on the SDK at build/test time — the real SDK is a
 * dynamic import in the smoke/spawn path. Shapes mirror the official reference
 * (SDKSystemMessage / SDKAssistantMessage / SDKResultMessage).
 */

export type SdkSystemMessage = {
  type: "system";
  subtype: "init";
  session_id: string;
  cwd?: string;
  tools?: string[];
  model?: string;
};

export type SdkAssistantMessage = {
  type: "assistant";
  session_id?: string;
  message: { content: Array<{ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown } | { type: string; [k: string]: unknown }> };
};

export type SdkResultMessage = {
  type: "result";
  subtype: "success" | "error_max_turns" | "error_during_execution" | "error_max_budget_usd" | "error_max_structured_output_retries";
  session_id: string;
  result?: string;
  errors?: string[];
  is_error?: boolean;
};

export type SdkMessage = SdkSystemMessage | SdkAssistantMessage | SdkResultMessage | { type: string; [k: string]: unknown };

/** Permission callback shape (canUseTool). */
export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<{ behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message?: string }>;

/** The options subset we pass to query(). */
export type QueryOptions = {
  cwd?: string;
  resume?: string;
  forkSession?: boolean;
  continue?: boolean;
  allowedTools?: string[];
  mcpServers?: Record<string, unknown>;
  canUseTool?: CanUseTool;
  permissionMode?: string;
  model?: string;
};

/** Structural match for the SDK's `query()` — an async-iterable of messages. */
export type QueryFn = (input: { prompt: string; options?: QueryOptions }) => AsyncIterable<SdkMessage>;
