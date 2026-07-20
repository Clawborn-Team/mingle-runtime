/**
 * Real runtime launcher (spec §5.4/§5.5/§9.1) — the provider-backed side of
 * `mingle-runtime start`. For each installed binding it builds the HTTP Event
 * Center client, assembles the real provider driver (Codex App Server / Claude
 * Agent SDK), and hands them to the daemon. Provider credentials stay with the
 * provider (codex keychain / ANTHROPIC_API_KEY|Bedrock|Vertex) — never in a
 * prompt, tool result, or log (§10). Missing SDK/auth degrades to an honest error
 * rather than a fake path.
 *
 * OpenClaw is not launched here: it runs via the openclaw-mingle plugin, whose
 * OpenClawDriver needs a live Gateway handle the install binding doesn't carry.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { startDaemon, toBinding, type DaemonHandle } from "./daemon.js";
import { resolveDriver } from "./driver-registry.js";
import { SqliteSessionRegistry } from "./sqlite-session-registry.js";
import type { AgentRuntimeDriver } from "./driver.js";
import type { EventCenterClient } from "./consumer.js";
import { expandHome, type InstalledBinding, type RuntimeConfig } from "../install/config.js";
import { createHttpEventCenterClient } from "../im/http-client.js";
import { DEFAULT_LOCAL_AGENT_PERSONA } from "./persona.js";
import { loadAuthoredPersona } from "./definition.js";
import { loadClaudeQuery, buildMingleMcpServer } from "../claude/real-query.js";
import { spawnCodexAppServer, type SpawnedAppServer } from "../codex/spawn.js";
import { CodexAppServerClient } from "../codex/client.js";
import { spawnWorkBuddyAcp } from "../workbuddy/spawn.js";
import { WorkBuddyAcpClient } from "../workbuddy/client.js";

function defaultSessionDbPath(): string {
  const dir = process.env.MINGLE_CONFIG_DIR || join(homedir(), ".mingle");
  mkdirSync(dir, { recursive: true });
  return join(dir, "sessions.db");
}

/** Assemble the real provider driver for one binding. Honest failure when the
 *  provider isn't installed/authenticated (§5.5) — no silent fake fallback. */
export async function resolveInstalledDriver(
  ib: InstalledBinding,
  imClient: EventCenterClient,
): Promise<{ driver: AgentRuntimeDriver; dispose?: () => void }> {
  // The owner-authored local definition IS who this agent is; the default persona
  // only applies when nothing was authored (product-vision two-tier model).
  const persona = (await loadAuthoredPersona(ib)) ?? DEFAULT_LOCAL_AGENT_PERSONA;
  switch (ib.runtimeKind) {
    case "claude-code": {
      const query = await loadClaudeQuery();
      if (!query) {
        throw new Error(
          "Claude Agent SDK not available. Install @anthropic-ai/claude-agent-sdk and provide auth " +
            "(ANTHROPIC_API_KEY, or Bedrock/Vertex env). See the install guide — no claude.ai subscription reuse.",
        );
      }
      const mcpServers =
        (await buildMingleMcpServer({
          sendMessage: async (to, body) => {
            await imClient.sendDm(to, body);
          },
        })) ?? undefined;
      const driver = resolveDriver("claude-code", {
        claude: {
          query,
          cwd: ib.dir ? expandHome(ib.dir) : process.cwd(),
          // YOLO (open the aperture): bypass permission prompts + no tool deny-list,
          // so the Local Agent can actually act on the owner's behalf. Revisit once we
          // see the effect (§5.5 honest-auth still holds; this is permissions, not auth).
          permissionMode: "bypassPermissions",
          deniedTools: [],
          persona,
          ...(mcpServers ? { mcpServers } : {}),
          ...(ib.model ? { model: ib.model } : {}),
        },
      });
      return { driver };
    }
    case "codex": {
      const server: SpawnedAppServer = spawnCodexAppServer();
      const client = new CodexAppServerClient(server.connection);
      await client.initialize({ name: "mingle-runtime", version: "0" });
      const driver = resolveDriver("codex", {
        codex: {
          client,
          persona,
          // YOLO: never pause for approval so the agent acts without blocking. (Sandbox
          // left at codex's default — the app-server's SandboxPolicy is a kebab-tagged
          // enum the client type doesn't model yet; widening it is a follow-up.)
          approvalPolicy: "never",
          ...(ib.model ? { model: ib.model } : {}),
        },
      });
      return { driver, dispose: () => server.stop() };
    }
    case "openclaw":
      throw new Error(
        "openclaw runs via the openclaw-mingle plugin, not `mingle-runtime start`. " +
          "Use the OpenClaw install command from the Bind Agent flow.",
      );
    case "workbuddy": {
      const server = spawnWorkBuddyAcp();
      const client = new WorkBuddyAcpClient(server.connection);
      const { loadSession } = await client.initialize({ name: "mingle-runtime", version: "0" });
      const driver = resolveDriver("workbuddy", {
        workbuddy: {
          client,
          loadSession,
          cwd: ib.dir ? expandHome(ib.dir) : process.cwd(),
          persona,
        },
      });
      return { driver, dispose: () => server.stop() };
    }
  }
}

/** Build every binding's real runtime and launch the daemon. Runs until stopped. */
export async function startRuntime(
  config: RuntimeConfig,
  opts: { registryPath?: string } = {},
): Promise<DaemonHandle> {
  const registry = new SqliteSessionRegistry(opts.registryPath ?? defaultSessionDbPath());
  const built = new Map<string, { driver: AgentRuntimeDriver; imClient: EventCenterClient }>();
  const disposers: Array<() => void> = [];

  const bindings = [];
  for (const ib of config.bindings) {
    const b = toBinding(ib);
    const imClient = createHttpEventCenterClient({ imUrl: ib.imUrl, key: ib.key, consumerId: ib.consumerId });
    const { driver, dispose } = await resolveInstalledDriver(ib, imClient);
    if (dispose) disposers.push(dispose);
    built.set(b.bindingId, { driver, imClient });
    bindings.push(b);
  }

  const handle = startDaemon({
    bindings,
    make: (b) => {
      const r = built.get(b.bindingId)!;
      return { driver: r.driver, registry, imClient: r.imClient };
    },
    onError: (b, err) => console.error(`[${b.bindingId}]`, err instanceof Error ? err.message : err),
  });

  // Ensure provider processes are torn down when the daemon stops.
  const stop = handle.stop;
  handle.stop = async () => {
    await stop();
    for (const d of disposers) d();
  };
  return handle;
}
