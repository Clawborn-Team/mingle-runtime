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
import { discoverClaudeSessions } from "../owner-context/claude-sessions.js";
import { discoverCodexSessions } from "../owner-context/codex-sessions.js";
import { prepareOwnerContextRefresh } from "../owner-context/runner.js";

function defaultSessionDbPath(): string {
  const dir = process.env.MINGLE_CONFIG_DIR || join(homedir(), ".mingle");
  mkdirSync(dir, { recursive: true });
  return join(dir, "sessions.db");
}

function ownerContextStatePath(binding: InstalledBinding): string {
  const dir = process.env.MINGLE_CONFIG_DIR || join(homedir(), ".mingle");
  return join(dir, "owner-context", `${binding.agentId}-${binding.runtimeKind}.json`);
}

function ownerContextConfig(binding: InstalledBinding) {
  return binding.ownerContext ?? { enabled: true, days: 7, excludeProjects: [], excludeSessions: [] };
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
          ownerContext: async (task) => {
            const cfg = ownerContextConfig(ib);
            if (!cfg.enabled) return "Owner context collection is paused. Return material_change=false.";
            try {
              const result = await prepareOwnerContextRefresh({
              runtime: "claude-code",
              mode: task.mode,
              days: task.days,
              statePath: ownerContextStatePath(ib),
              source: () => discoverClaudeSessions({
                projectsRoot: join(homedir(), ".claude", "projects"),
                days: task.days,
                excludeProjects: [...new Set([...cfg.excludeProjects, ...task.excludedProjects])],
                excludeSessions: cfg.excludeSessions,
              }),
              });
              await imClient.reportOwnerContext?.({ status: "prepared", updated_at: Date.now(), mode: task.mode, material_change: result.materialChange });
              return result.prompt;
            } catch (error) {
              await imClient.reportOwnerContext?.({ status: "failure", updated_at: Date.now(), mode: task.mode, error: error instanceof Error ? error.message : String(error) });
              throw error;
            }
          },
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
          ownerContext: async (task) => {
            const cfg = ownerContextConfig(ib);
            if (!cfg.enabled) return "Owner context collection is paused. Return material_change=false.";
            try {
              const result = await prepareOwnerContextRefresh({
              runtime: "codex",
              mode: task.mode,
              days: task.days,
              statePath: ownerContextStatePath(ib),
              source: () => discoverCodexSessions({
                client,
                days: task.days,
                excludeProjects: [...new Set([...cfg.excludeProjects, ...task.excludedProjects])],
                excludeSessions: cfg.excludeSessions,
              }),
              });
              await imClient.reportOwnerContext?.({ status: "prepared", updated_at: Date.now(), mode: task.mode, material_change: result.materialChange });
              return result.prompt;
            } catch (error) {
              await imClient.reportOwnerContext?.({ status: "failure", updated_at: Date.now(), mode: task.mode, error: error instanceof Error ? error.message : String(error) });
              throw error;
            }
          },
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
      const cwd = ib.dir ? expandHome(ib.dir) : process.cwd();
      // YOLO (open the aperture): bypass permission prompts so the Local Agent acts on
      // the owner's behalf without blocking (parity with codex approvalPolicy:"never" /
      // claude bypassPermissions). Spawn cwd = the binding dir because codebuddy's tools
      // operate in the PROCESS cwd, not the session/new cwd (verified live).
      const server = spawnWorkBuddyAcp({ cwd, acpArgs: ["--permission-mode", "bypassPermissions"] });
      const client = new WorkBuddyAcpClient(server.connection);
      const { loadSession } = await client.initialize({ name: "mingle-runtime", version: "0" });
      const driver = resolveDriver("workbuddy", {
        workbuddy: { client, loadSession, cwd, persona },
      });
      return { driver, dispose: () => server.stop() };
    }
  }
}

/** Build every binding's real runtime and launch the daemon. Runs until stopped. */
export async function startRuntime(
  config: RuntimeConfig,
  opts: { registryPath?: string; wait?: number; digestMs?: number } = {},
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
    // Poll cadence is overridable (tests use a short wait so stop() returns promptly
    // instead of blocking on a 25s long-poll; a real start keeps the defaults).
    ...(opts.wait !== undefined ? { wait: opts.wait } : {}),
    ...(opts.digestMs !== undefined ? { digestMs: opts.digestMs } : {}),
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
