/**
 * Bridge to the real `@anthropic-ai/claude-agent-sdk`. Kept isolated + behind a
 * DYNAMIC import so the core package builds, typechecks, and unit-tests without
 * the SDK installed — the driver depends only on the structural `QueryFn`. The
 * install flow (A4) adds the SDK when the user picks the Claude driver.
 *
 * Also builds the in-process Mingle SDK-MCP server: Mingle capabilities are
 * exposed as restricted tools whose handlers hold any short-lived Agent
 * capability OUT of the model's reach (§10) — the model calls a tool, the shim
 * calls Mingle Actions.
 */
import type { QueryFn } from "./sdk-types.js";

/** Resolve the real SDK `query` if the package is installed, else null. */
export async function loadClaudeQuery(): Promise<QueryFn | null> {
  try {
    const mod = (await import("@anthropic-ai/claude-agent-sdk")) as { query?: QueryFn };
    return mod.query ?? null;
  } catch {
    return null; // SDK not installed — caller degrades honestly
  }
}

/**
 * Build the in-process Mingle MCP server from the real SDK's helpers, if present.
 * `actions` is the Mingle Actions shim (send DM, post channel, …) — the driver
 * passes the returned config straight into query({ options: { mcpServers } }).
 * Returns null when the SDK isn't installed.
 */
export async function buildMingleMcpServer(actions: {
  sendMessage: (to: string, body: string) => Promise<void>;
}): Promise<Record<string, unknown> | null> {
  try {
    const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as {
      createSdkMcpServer?: (o: unknown) => unknown;
      tool?: (name: string, desc: string, schema: unknown, handler: (a: unknown) => Promise<unknown>) => unknown;
    };
    const z = (await import("zod")) as unknown as { z: { string: () => unknown } };
    if (!sdk.createSdkMcpServer || !sdk.tool || !z?.z) return null;

    const sendTool = sdk.tool(
      "mingle_send_message",
      "Send a direct message as this Mingle agent to a peer account id.",
      { to: z.z.string(), body: z.z.string() },
      async (args: unknown) => {
        const a = args as { to: string; body: string };
        await actions.sendMessage(a.to, a.body);
        return { content: [{ type: "text", text: "sent" }] };
      },
    );
    const server = sdk.createSdkMcpServer({ name: "mingle", version: "0", tools: [sendTool] });
    return { mingle: server as unknown };
  } catch {
    return null;
  }
}
